import { Outlet } from '@remix-run/react';

export function ErrorBoundary() {
  return <div>Error occurred</div>;
}

export default function App() {
  return <Outlet />;
}
