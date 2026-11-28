import { Outlet } from '@remix-run/react';
import { withSentry } from '@sentry/remix';

function App() {
  return <Outlet />;
}

export default withSentry(App);
