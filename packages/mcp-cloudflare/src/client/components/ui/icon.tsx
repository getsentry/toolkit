interface IconProps {
  className?: string | undefined;
  path: string;
  viewBox?: string;
  title?: string;
}

export function Icon({
  className,
  path,
  viewBox = "0 0 32 32",
  title = "Icon",
}: IconProps) {
  return (
    <svg
      className={className}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-labelledby="icon-title"
    >
      <title id="icon-title">{title}</title>
      <path d={path} fill="currentColor" />
    </svg>
  );
}
