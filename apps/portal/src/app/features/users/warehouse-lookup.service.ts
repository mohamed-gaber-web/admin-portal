import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { map, type Observable } from "rxjs";
import {
  API_ROUTES,
  D365_COMPANY_HEADER,
  companyListSchema,
  type Company
} from "@growpath/contracts";
import { environment } from "@env";
import { ApiService } from "@core/http/api.service";

/** A D365 warehouse, as the picker shows it. */
export interface D365Warehouse {
  warehouseId: string;
  name: string;
}

interface WarehousesResponse {
  value?: { WarehouseId?: string; WarehouseName?: string }[];
}

/**
 * Where the warehouse picker gets its choices.
 *
 * Companies come from the portal's own `/companies`; warehouses come live from
 * Dynamics through the API's pass-through, the same `/d365/data/*` route the
 * mobile app uses. The portal holds no D365 credential — the API attaches it —
 * and the company travels as the `x-d365-company` header, which the API
 * resolves under row level security to one of this tenant's environments.
 *
 * `HttpClient` directly rather than `ApiService` for the warehouses, only
 * because `ApiService` does not carry custom headers. The URL and the auth
 * interceptor are the same.
 */
@Injectable({ providedIn: "root" })
export class WarehouseLookupService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);

  listCompanies(): Observable<Company[]> {
    return this.api.getValidated(API_ROUTES.companies, companyListSchema);
  }

  /**
   * One company's warehouses.
   *
   * `cross-company=true` plus a `dataAreaId` filter, because without them D365
   * answers for the service principal's *default* legal entity whichever
   * company was meant — two companies in one environment would show the same
   * list, and a warehouse could be saved against the wrong one. The header
   * picks the environment; the filter picks the legal entity inside it.
   */
  listWarehouses(company: Pick<Company, "id" | "dataAreaId">): Observable<D365Warehouse[]> {
    const dataAreaId = company.dataAreaId.replace(/'/g, "''");
    return this.http
      .get<WarehousesResponse>(`${environment.apiBaseUrl}/d365/data/Warehouses`, {
        headers: { [D365_COMPANY_HEADER]: company.id },
        params: {
          "cross-company": "true",
          $filter: `dataAreaId eq '${dataAreaId}'`,
          $select: "WarehouseId,WarehouseName",
          $orderby: "WarehouseId",
          $top: "500"
        }
      })
      .pipe(
        map((body) =>
          (body.value ?? [])
            .filter((row) => !!row.WarehouseId)
            .map((row) => ({
              warehouseId: row.WarehouseId as string,
              name: row.WarehouseName?.trim() || (row.WarehouseId as string)
            }))
        )
      );
  }
}
