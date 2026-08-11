export interface HttpErrorShape {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
}

export class DaemonHttpError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details?: Record<string, unknown>;

    constructor(shape: HttpErrorShape) {
        super(shape.message);
        this.name = "DaemonHttpError";
        this.status = shape.status;
        this.code = shape.code;
        this.details = shape.details;
    }
}

export function createBadRequestError(message: string, details?: Record<string, unknown>): DaemonHttpError {
    return new DaemonHttpError({
        status: 400,
        code: "bad_request",
        message,
        details
    });
}

export function createUnauthorizedError(details?: Record<string, unknown>): DaemonHttpError {
    return new DaemonHttpError({
        status: 401,
        code: "unauthorized",
        message: "unauthorized",
        details
    });
}

export function createNotFoundError(message: string, details?: Record<string, unknown>): DaemonHttpError {
    return new DaemonHttpError({
        status: 404,
        code: "not_found",
        message,
        details
    });
}

export function isDaemonHttpError(error: unknown): error is DaemonHttpError {
    return error instanceof DaemonHttpError;
}
