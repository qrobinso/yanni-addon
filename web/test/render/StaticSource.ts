// The stub frame source of the Swift FrameLoopTests (`StaticSource`): returns `current` and logs every request.
import type { FaceFrame, FaceFrameSource } from '../../src/model/FaceFrame';

export class StaticSource implements FaceFrameSource {
  requested: number[] = [];
  /// Swift `frame` (renamed: the property would clash with the `frame(_:)` method in TS).
  constructor(public current: FaceFrame) {}
  frame(presentationTime: number): FaceFrame {
    this.requested.push(presentationTime);
    return this.current;
  }
}
