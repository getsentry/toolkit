import { Outlet } from '@remix-run/react';
import { captureRemixErrorBoundaryError } from '@sentry/remix';

export function ErrorBoundary() {
  captureRemixErrorBoundaryError();
  return <div>Error occurred</div>;
}

export default function App() {
  return <Outlet />;
}
