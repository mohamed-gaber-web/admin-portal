import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { ThemeService } from "@core/theme/theme.service";
import { ToastHostComponent } from "@shared/ui";

/**
 * The application root.
 *
 * Almost nothing: the routed view, and the toast host that has to be mounted
 * exactly once and outlive every navigation.
 *
 * `ThemeService` is injected here purely so it is constructed at startup — it
 * applies the stored preference to <html> in its own effect, and nothing else
 * would otherwise ask for it until a user opened Settings.
 */
@Component({
  selector: "app-root",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, ToastHostComponent],
  template: `
    <router-outlet />
    <ui-toast-host />
  `
})
export class AppComponent {
  private readonly theme = inject(ThemeService);
}
