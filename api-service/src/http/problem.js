'use strict';

const SAFE_SERVER_MESSAGE = 'The request could not be completed.';

function toProblem(error, requestId = null) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === 'string' && error.code.length <= 128
    ? error.code
    : status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  const clientMessage = status >= 500 ? SAFE_SERVER_MESSAGE : (error?.message || 'Request failed');

  return {
    type: `https://errors.flowdesk.live/${encodeURIComponent(code.toLowerCase())}`,
    title: code.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
    status,
    detail: clientMessage,
    code,
    request_id: requestId || null,
  };
}

function installErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    if (error?.validation) {
      error.status = 400;
      error.code = 'REQUEST_VALIDATION_FAILED';
      error.message = 'Request body, params, query, or headers failed validation';
    }
    const problem = toProblem(error, request.id);
    if (problem.status >= 500) request.log?.error({ err: error, code: problem.code }, 'request failed');
    else request.log?.warn({ code: problem.code }, 'request rejected');

    reply
      .code(problem.status)
      .type('application/problem+json')
      .send(problem);
  });
}

module.exports = { toProblem, installErrorHandler, SAFE_SERVER_MESSAGE };
