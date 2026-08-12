import { Controller, Get, NotFoundException, Param, UseGuards } from "@nestjs/common";
import { API_ROUTES, type Company } from "@growpath/contracts";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { CompanyService } from "./company.service";

/**
 * The first tenant-scoped routes.
 *
 * They exist as much to prove the mechanism as to serve data: a request reaches
 * them only with a valid access token, and the tenant they operate on comes from
 * that token's claims through the request context, never from the URL.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class CompanyController {
  constructor(private readonly companies: CompanyService) {}

  @Get(API_ROUTES.companies)
  list(): Promise<Company[]> {
    return this.companies.list();
  }

  @Get(API_ROUTES.company)
  async get(@Param("id") id: string): Promise<Company> {
    const company = await this.companies.find(id);
    if (!company) {
      // 404, never 403. A 403 would confirm the company exists, which is itself
      // the leak — it turns an id into an oracle for another tenant's data.
      throw new NotFoundException({ message: "Company not found." });
    }
    return company;
  }
}
