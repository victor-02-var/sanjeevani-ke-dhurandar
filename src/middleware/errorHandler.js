/**
 * Centralized Error Handling Middleware for Express
 */
export const errorHandler = (err, req, res, next) => {
  // Log the full error to the console for backend debugging
  console.error('❌ Backend Error:', err);

  // Determine appropriate HTTP Status Code
  const statusCode = res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;

  // Extract a readable error message
  const errorMessage = err.message || (typeof err === 'string' ? err : 'Internal Server Error');

  // Send structured JSON response
  res.status(statusCode).json({
    success: false,
    error: errorMessage,
    // Show full stack trace only during development mode
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
};