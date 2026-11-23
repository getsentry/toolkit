export const LIB_VERSION =
  (typeof process !== "undefined"
    ? process.env["npm_package_version"]
    : undefined) || "0.0.0";
