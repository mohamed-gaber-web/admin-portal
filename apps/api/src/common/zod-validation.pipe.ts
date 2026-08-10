import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * Validates incoming request data against a shared Zod schema. On failure it
 * throws a 400 with the schema's issues, so every request is checked against
 * the single source of truth in @growpath/contracts.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Validation failed",
        issues: result.error.issues
      });
    }
    return result.data;
  }
}
