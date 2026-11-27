import { Outlet } from '@remix-run/react';

const ErrorBoundary = () => {
  return <div>Error occurred</div>;
};

export { ErrorBoundary };

export default function App() {
  return <Outlet />;
}
