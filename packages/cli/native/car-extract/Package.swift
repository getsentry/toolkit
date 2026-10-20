// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "AssetCatalogParser",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "car-extract", targets: ["CarExtract"])],
    targets: [
        .target(
            name: "AssetCatalogParser",
            dependencies: ["ObjcSupport"],
            linkerSettings: [
                .unsafeFlags(["-F", "/System/Library/PrivateFrameworks", "-framework", "CoreUI"])
            ]),
        .target(name: "ObjcSupport"),
        .executableTarget(name: "CarExtract", dependencies: ["AssetCatalogParser"])
    ]
)
