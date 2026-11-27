import { createRequestHandler } from "@react-router/node";

export default createRequestHandler({
  build: require("./build"),
});
