// Port of FaceRendering/FaceRenderer.swift on WebGPU.
import type { FaceFrame } from '../model/FaceFrame';
import { EyeGeometry } from './EyeGeometry';
import shaderSource from './EyeShader.wgsl?raw';
import { resolvedStyle } from './MoodColorMix';
import { makeRenderStyle, type RenderStyle } from './RenderStyle';
import { FrameUniforms, frameUniformBytes, frameUniformFloats, packFrameUniforms } from './RenderUniforms';
import { Viewport } from './Viewport';

export { shaderSource };

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/// Draws a `FaceFrame` with one full-screen WebGPU pass (one triangle, `EyeShader.wgsl`).
///
/// - **Uniforms:** one 1264-byte uniform buffer, written each frame from a reused Float32Array with
///   `queue.writeBuffer` (WebGPU copies on submit, so the ring of four buffers the Metal renderer needs is not needed).
/// - **Sizing:** an `HTMLCanvasElement` is kept at its CSS size × `devicePixelRatio` (checked every frame, so a resize
///   or rotation needs no event wiring); an `OffscreenCanvas` keeps the size its owner gives it.
/// - **Device loss:** the renderer re-initialises itself on the same canvas; `render` returns false until it is back.
/// - The per-frame path reuses the uniform object, the packed array and the resolved style (geometry temporaries
///   aside; see `EyeGeometry`).
export class FaceRenderer {
  /// The style the next frame is drawn with.
  style: RenderStyle = makeRenderStyle();
  device: GPUDevice | undefined;
  /// The canvas texture format (`bgra8unorm` on Apple, else `rgba8unorm`; never an sRGB format: the shader encodes).
  format: GPUTextureFormat = 'bgra8unorm';
  /// Frames drawn, device losses survived.
  frames = 0;
  deviceLosses = 0;
  /// Called after a lost device came back.
  onRestored: (() => void) | undefined;

  private canvas: AnyCanvas | undefined;
  private context: GPUCanvasContext | undefined;
  private module: GPUShaderModule | undefined;
  private layout: GPUBindGroupLayout | undefined;
  private pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private uniformBuffer: GPUBuffer | undefined;
  private bindGroup: GPUBindGroup | undefined;
  private readonly uniforms = new FrameUniforms();
  private readonly packed: Float32Array<ArrayBuffer> = new Float32Array(frameUniformFloats);
  private readonly styleScratch = makeRenderStyle();
  private destroyed = false;

  get isReady(): boolean { return this.bindGroup !== undefined; }

  /// Sets up WebGPU and (optionally) a canvas to draw into. Throws when WebGPU is unavailable or the shader fails.
  async init(canvas?: AnyCanvas): Promise<void> {
    this.canvas = canvas;
    const gpu = navigator.gpu;
    if (!gpu) throw new Error('WebGPU unavailable');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    this.device = device;
    this.pipelines.clear();
    void device.lost.then((info) => this.handleLoss(device, info));

    const module = device.createShaderModule({ label: 'Face', code: shaderSource });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error('Face shader: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
    this.module = module;
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    this.uniformBuffer = device.createBuffer({ label: 'FaceUniforms', size: frameUniformBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (canvas) {
      this.format = gpu.getPreferredCanvasFormat();
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) throw new Error('No WebGPU canvas context');
      ctx.configure({ device, format: this.format, alphaMode: 'opaque' });
      this.context = ctx;
      this.pipeline(this.format);
    }
    this.bindGroup = device.createBindGroup({ layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }] });
  }

  private handleLoss(device: GPUDevice, info: GPUDeviceLostInfo): void {
    if (this.destroyed || device !== this.device || info.reason === 'destroyed') return;
    this.bindGroup = undefined;
    this.deviceLosses += 1;
    const retry = (delay: number): void => {
      setTimeout(() => {
        if (this.destroyed) return;
        this.init(this.canvas).then(() => this.onRestored?.(), () => retry(Math.min(delay * 2, 10_000)));
      }, delay);
    };
    retry(250);
  }

  private pipeline(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.pipelines.get(format);
    if (!p) {
      const device = this.device!, module = this.module!;
      p = device.createRenderPipeline({
        label: 'Face',
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout!] }),
        vertex: { module, entryPoint: 'faceVertex' },
        fragment: { module, entryPoint: 'faceFragment', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(format, p);
    }
    return p;
  }

  /// Keeps an HTMLCanvasElement's drawable at CSS size × devicePixelRatio. Returns the drawable size.
  resize(): { width: number; height: number } {
    const c = this.canvas;
    if (c && typeof HTMLCanvasElement !== 'undefined' && c instanceof HTMLCanvasElement) {
      const dpr = globalThis.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    return { width: c?.width ?? 1, height: c?.height ?? 1 };
  }

  /// Packs the uniforms exactly as the Swift renderer does: viewport fitted to the drawable (with the frame's caption
  /// inset) unless one is given, style resolved for the frame's mood colour.
  packUniforms(frame: FaceFrame, width: number, height: number, viewport?: Viewport): Float32Array<ArrayBuffer> {
    const vp = viewport ?? Viewport.fitting(width, height, this.style, frame.captionInset);
    EyeGeometry.uniforms(frame, vp, resolvedStyle(this.style, frame, this.styleScratch), this.uniforms);
    return packFrameUniforms(this.uniforms, this.packed);
  }

  private encode(frame: FaceFrame, view: GPUTextureView, format: GPUTextureFormat, width: number, height: number,
    viewport?: Viewport): GPUCommandEncoder {
    const device = this.device!;
    device.queue.writeBuffer(this.uniformBuffer!, 0, this.packUniforms(frame, width, height, viewport));
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(this.pipeline(format));
    pass.setBindGroup(0, this.bindGroup!);
    pass.draw(3);
    pass.end();
    return enc;
  }

  /// Renders one frame into the canvas. False when not drawn (not ready, or recovering from a lost device).
  render(frame: FaceFrame, viewport?: Viewport): boolean {
    if (!this.isReady || !this.context) return false;
    const { width, height } = this.resize();
    const tex = this.context.getCurrentTexture();
    this.device!.queue.submit([this.encode(frame, tex.createView(), this.format, width, height, viewport).finish()]);
    this.frames += 1;
    return true;
  }

  /// Renders one frame offscreen and returns tightly packed RGBA8 pixels (sRGB-encoded). Not for the per-frame path:
  /// it allocates a texture and waits for the GPU.
  async renderPixels(frame: FaceFrame, width: number, height: number, viewport?: Viewport): Promise<Uint8Array> {
    if (!this.isReady) throw new Error('FaceRenderer not ready');
    const device = this.device!;
    const tex = device.createTexture({ size: [width, height], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const rowBytes = width * 4, stride = Math.ceil(rowBytes / 256) * 256;
    const buf = device.createBuffer({ size: stride * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.encode(frame, tex.createView(), 'rgba8unorm', width, height, viewport);
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: stride }, [width, height]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(rowBytes * height);
    for (let y = 0; y < height; y++) out.set(src.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
    buf.unmap();
    buf.destroy();
    tex.destroy();
    return out;
  }

  destroy(): void {
    this.destroyed = true;
    this.uniformBuffer?.destroy();
    this.device?.destroy();
    this.bindGroup = undefined;
  }
}
