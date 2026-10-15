import AssetCatalogParser
import Darwin
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("usage: car-extract <Assets.car> <output-directory>\n", stderr)
    exit(64)
}

// NSClassFromString only sees loaded classes. Explicitly load CoreUI before
// calling the legacy parser, whose private API lookups depend on CUICatalog.
guard dlopen("/System/Library/PrivateFrameworks/CoreUI.framework/CoreUI", RTLD_NOW | RTLD_GLOBAL) != nil else {
    fputs("CoreUI is unavailable\n", stderr)
    exit(1)
}

CommandLine.arguments[1].withCString { path in
    CommandLine.arguments[2].withCString { output in
        swift_inspect_asset_catalog(path, outputPath: output)
    }
}
