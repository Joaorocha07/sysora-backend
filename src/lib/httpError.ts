export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new HttpError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Não autenticado.') {
    return new HttpError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'Sem permissão para esta ação.') {
    return new HttpError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Recurso não encontrado.') {
    return new HttpError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string) {
    return new HttpError(409, 'CONFLICT', message);
  }
}
