export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function badRequest(message: string): never {
  throw new ApiError(400, "bad_request", message);
}
