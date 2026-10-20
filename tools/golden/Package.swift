// swift-tools-version: 6.0
import PackageDescription

// The golden recorder: drives the real Swift FaceEngine through scripted scenarios and writes per-frame traces to
// fixtures/golden. The Swift sources are read-only; this package only depends on them by path.
let package = Package(
    name: "golden",
    platforms: [.macOS("26.0")],
    dependencies: [.package(name: "YanniFace", path: "../../../yanni/Packages/YanniFace")],
    targets: [
        .executableTarget(name: "golden-record", dependencies: [
            .product(name: "FaceEngine", package: "YanniFace"),
            .product(name: "FaceModel", package: "YanniFace"),
            .product(name: "FaceLife", package: "YanniFace"),
            // Only for EdgeGeometry.fitting (the app's own edge geometry); the result goes into the script as numbers.
            .product(name: "FaceRendering", package: "YanniFace"),
        ]),
        // Reference PNGs + uniforms from the real Metal renderer, for the WebGPU port's parity test (fixtures/render).
        .executableTarget(name: "golden-render", dependencies: [
            .product(name: "FaceModel", package: "YanniFace"),
            .product(name: "FaceRendering", package: "YanniFace"),
        ]),
    ]
)
