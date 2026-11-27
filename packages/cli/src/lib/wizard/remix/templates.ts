/**
 * Code templates the Remix codemods insert.
 */

export const ERROR_BOUNDARY_TEMPLATE = `const ErrorBoundary = () => {
  const error = useRouteError();
  captureRemixErrorBoundaryError(error);
  return <div>Something went wrong</div>;
};
`;

export const HANDLE_ERROR_TEMPLATE = `const handleError = Sentry.wrapHandleErrorWithSentry((error, { request }) => {
  // Custom handleError implementation
});
`;
