class TestResizeObserver implements ResizeObserver {
  disconnect() {}

  observe(_target: Element, _options?: ResizeObserverOptions) {}

  unobserve(_target: Element) {}
}

const environment: Partial<typeof globalThis> = globalThis;
if (!environment.ResizeObserver) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
    writable: true,
  });
}

if (typeof Element !== "undefined") {
  const elementPrototype: Partial<Element> = Element.prototype;
  elementPrototype.scrollIntoView ??= () => {};
}
