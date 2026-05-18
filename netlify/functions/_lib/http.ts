import type { HandlerResponse } from '@netlify/functions';

const baseHeaders = {
  'Content-Type': 'application/json'
};

export const ok = <T>(body: T): HandlerResponse => ({
  statusCode: 200,
  headers: baseHeaders,
  body: JSON.stringify(body)
});

export const created = <T>(body: T): HandlerResponse => ({
  statusCode: 201,
  headers: baseHeaders,
  body: JSON.stringify(body)
});

export const badRequest = (message: string): HandlerResponse => ({
  statusCode: 400,
  headers: baseHeaders,
  body: JSON.stringify({ error: message })
});

export const unauthorized = (message = 'Unauthorized'): HandlerResponse => ({
  statusCode: 401,
  headers: baseHeaders,
  body: JSON.stringify({ error: message })
});

export const forbidden = (message = 'Forbidden'): HandlerResponse => ({
  statusCode: 403,
  headers: baseHeaders,
  body: JSON.stringify({ error: message })
});

export const notFound = (message = 'Not found'): HandlerResponse => ({
  statusCode: 404,
  headers: baseHeaders,
  body: JSON.stringify({ error: message })
});

export const serverError = (message = 'Internal server error'): HandlerResponse => ({
  statusCode: 500,
  headers: baseHeaders,
  body: JSON.stringify({ error: message })
});
