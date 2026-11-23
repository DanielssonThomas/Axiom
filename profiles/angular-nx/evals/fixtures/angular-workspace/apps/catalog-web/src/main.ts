import { provideZonelessChangeDetection, Component } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { DashboardComponent, ResultsComponent } from "@fixture/catalog";
import type { CatalogDisplay } from "@fixture/catalog";

@Component({
  selector: "fixture-app",
  imports: [DashboardComponent, ResultsComponent],
  template: "<main><h1>{{ display.title }}</h1><fixture-dashboard /><fixture-results /></main>",
})
class CatalogApplication {
  protected readonly display: CatalogDisplay = { title: "Catalog fixture" };
}

void bootstrapApplication(CatalogApplication, { providers: [provideZonelessChangeDetection()] });
