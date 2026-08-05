import { Component } from "@angular/core";
import { API_ROUTES } from "@growpath/contracts";

@Component({
  selector: "app-root",
  standalone: true,
  template: `
    <main>
      <h1>Grow Path Admin Portal</h1>
      <p>API health endpoint: <code>{{ healthRoute }}</code></p>
    </main>
  `
})
export class AppComponent {
  protected readonly healthRoute = API_ROUTES.health;
}
