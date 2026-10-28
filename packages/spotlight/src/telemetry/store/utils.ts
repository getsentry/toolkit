export function toTimestamp(date: string | number) {
  if (typeof date === "string") return new Date(date).getTime();
  return date * 1000;
}

export function relativeNsToTimestamp(startTs: number, ns: number | string) {
  const nsStr = ns.toString();
  return nsStr.length > 3
    ? startTs + Number.parseInt(nsStr.slice(0, -3), 10) / 1000
    : startTs;
}
