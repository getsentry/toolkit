/**
 * Extracts browser name and major version from a User-Agent string
 * Returns format like "Chrome/131" or "Firefox/122"
 */
export function parseBrowserFromUserAgent(userAgent: string): string {
  if (!userAgent) return "unknown";

  // Check for Chrome (but not Edge which also contains Chrome)
  if (userAgent.includes("Chrome/") && !userAgent.includes("Edg/")) {
    const match = userAgent.match(/Chrome\/([\d]+)/);
    return match ? `Chrome/${match[1]}` : "Chrome";
  }

  // Check for Firefox
  if (userAgent.includes("Firefox/")) {
    const match = userAgent.match(/Firefox\/([\d]+)/);
    return match ? `Firefox/${match[1]}` : "Firefox";
  }

  // Check for Safari (but not Chrome which also contains Safari)
  if (userAgent.includes("Safari/") && !userAgent.includes("Chrome")) {
    const match = userAgent.match(/Version\/([\d]+)/);
    return match ? `Safari/${match[1]}` : "Safari";
  }

  // Check for Edge
  if (userAgent.includes("Edg/")) {
    const match = userAgent.match(/Edg\/([\d]+)/);
    return match ? `Edge/${match[1]}` : "Edge";
  }

  // Generic fallback - try to extract first meaningful part
  const match = userAgent.match(/^([^/\s(]+)/);
  return match ? match[1] : "unknown";
}
