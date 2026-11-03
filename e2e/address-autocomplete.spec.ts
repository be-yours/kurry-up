import { test, expect } from "@playwright/test"

/**
 * Mock script that replaces Google Maps Places API.
 * Creates a fake Autocomplete that:
 * - Attaches to an input element
 * - Shows a real .pac-container dropdown (same DOM structure Google uses)
 * - When a .pac-item is clicked, fires "place_changed" with parsed address data
 */
const GOOGLE_MAPS_MOCK_SCRIPT = `
  window.google = {
    maps: {
      event: {
        clearInstanceListeners: function() {},
      },
      places: {
        Autocomplete: function(input, options) {
          this._input = input;
          this._listeners = {};
          this._options = options;

          var container = document.createElement('div');
          container.className = 'pac-container pac-logo';
          container.style.cssText = 'z-index:10000;position:absolute;display:none;width:' + input.offsetWidth + 'px;';
          document.body.appendChild(container);
          this._container = container;

          var self = this;
          this._place = null;

          var suggestions = [
            {
              description: '2 Rue de la Paix, 75002 Paris, France',
              place: {
                address_components: [
                  { long_name: '2', types: ['street_number'] },
                  { long_name: 'Rue de la Paix', types: ['route'] },
                  { long_name: 'Paris', types: ['locality'] },
                  { long_name: '75002', types: ['postal_code'] },
                  { long_name: 'France', types: ['country'] },
                ],
                geometry: {
                  location: {
                    lat: function() { return 48.8698; },
                    lng: function() { return 2.3302; },
                  }
                }
              }
            },
            {
              description: '2 Rue de la Paix, 69001 Lyon, France',
              place: {
                address_components: [
                  { long_name: '2', types: ['street_number'] },
                  { long_name: 'Rue de la Paix', types: ['route'] },
                  { long_name: 'Lyon', types: ['locality'] },
                  { long_name: '69001', types: ['postal_code'] },
                  { long_name: 'France', types: ['country'] },
                ],
                geometry: {
                  location: {
                    lat: function() { return 45.7676; },
                    lng: function() { return 4.8344; },
                  }
                }
              }
            }
          ];

          input.addEventListener('input', function() {
            var query = input.value.toLowerCase();
            if (query.length < 2) {
              container.style.display = 'none';
              return;
            }

            container.innerHTML = '';
            var matching = suggestions.filter(function(s) {
              return s.description.toLowerCase().includes(query);
            });

            if (matching.length === 0) {
              container.style.display = 'none';
              return;
            }

            matching.forEach(function(s) {
              var item = document.createElement('div');
              item.className = 'pac-item';
              item.setAttribute('data-testid', 'pac-item');
              item.innerHTML = '<span class="pac-icon pac-icon-marker"></span>' +
                '<span class="pac-item-query"><span class="pac-matched">' +
                s.description.split(',')[0] +
                '</span></span>' +
                '<span>' + s.description.split(',').slice(1).join(',') + '</span>';
              item.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:13px;';

              item.addEventListener('mousedown', function(e) {
                e.preventDefault();
                self._place = s.place;
                container.style.display = 'none';
                if (self._listeners['place_changed']) {
                  self._listeners['place_changed'].forEach(function(cb) { cb(); });
                }
              });

              container.appendChild(item);
            });

            var rect = input.getBoundingClientRect();
            container.style.top = (rect.bottom + window.scrollY) + 'px';
            container.style.left = (rect.left + window.scrollX) + 'px';
            container.style.width = rect.width + 'px';
            container.style.display = 'block';
          });

          input.addEventListener('blur', function() {
            setTimeout(function() { container.style.display = 'none'; }, 300);
          });
        }
      }
    }
  };

  window.google.maps.places.Autocomplete.prototype.addListener = function(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  };

  window.google.maps.places.Autocomplete.prototype.getPlace = function() {
    return this._place || {};
  };
`

test.describe("AddressAutocomplete", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept Google Maps script and return mock
    await page.route("**/maps.googleapis.com/maps/api/js**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: GOOGLE_MAPS_MOCK_SCRIPT,
      })
    })
  })

  test("standalone: typing shows suggestions and clicking one fills all fields", async ({
    page,
  }) => {
    await page.goto("/address-test")
    await expect(page.getByTestId("page-title")).toBeVisible()

    // Find the street input in the standalone section
    const section = page.getByTestId("standalone-section")
    const streetInput = section.locator('input[placeholder="2 rue de la Paix"]')
    await expect(streetInput).toBeVisible()

    // Type to trigger suggestions
    await streetInput.click()
    await streetInput.fill("2 rue de la")

    // Wait for pac-container with items to appear
    const pacContainer = page.locator('.pac-container:has(.pac-item)')
    await expect(pacContainer).toBeVisible({ timeout: 5000 })

    // Click the first suggestion (Paris)
    const pacItems = pacContainer.locator(".pac-item")
    const count = await pacItems.count()
    expect(count).toBeGreaterThanOrEqual(1)
    await pacItems.first().click()

    // Verify city, postalCode, country were filled
    const cityInput = section.locator('input[placeholder="Paris"]')
    const postalCodeInput = section.locator('input[placeholder="75001"]')
    const countryInput = section.locator('input[placeholder="France"]')

    await expect(cityInput).toHaveValue("Paris", { timeout: 3000 })
    await expect(postalCodeInput).toHaveValue("75002")
    await expect(countryInput).toHaveValue("France")
  })

  test("dialog: clicking a suggestion does NOT close the dialog", async ({
    page,
  }) => {
    await page.goto("/address-test")
    await expect(page.getByTestId("page-title")).toBeVisible()

    // Open the dialog
    await page.getByTestId("open-dialog-btn").click()
    const dialogContent = page.locator('[data-slot="dialog-content"]')
    await expect(dialogContent).toBeVisible()

    // Type in the street field inside the dialog
    const streetInput = dialogContent.locator(
      'input[placeholder="2 rue de la Paix"]'
    )
    await streetInput.click()
    await streetInput.fill("2 rue de la")

    // Wait for suggestions in the visible pac-container
    const pacContainer = page.locator('.pac-container:has(.pac-item)')
    await expect(pacContainer).toBeVisible({ timeout: 5000 })
    const pacItems = pacContainer.locator(".pac-item")

    // Click a suggestion
    await pacItems.first().click()

    // Dialog should STILL be open
    await expect(dialogContent).toBeVisible()

    // Fields should be filled
    const cityInput = dialogContent.locator('input[placeholder="Paris"]')
    await expect(cityInput).toHaveValue("Paris", { timeout: 3000 })
  })

  test("manual fallback: fields are editable without autocomplete", async ({
    page,
  }) => {
    await page.goto("/address-test")
    await expect(page.getByTestId("page-title")).toBeVisible()

    const section = page.getByTestId("standalone-section")
    const streetInput = section.locator('input[placeholder="2 rue de la Paix"]')
    const cityInput = section.locator('input[placeholder="Paris"]')
    const postalCodeInput = section.locator('input[placeholder="75001"]')
    const countryInput = section.locator('input[placeholder="France"]')

    // Fill all fields manually
    await streetInput.fill("10 Avenue des Champs-Élysées")
    await cityInput.fill("Paris")
    await postalCodeInput.fill("75008")
    await countryInput.fill("France")

    // Verify values
    await expect(streetInput).toHaveValue("10 Avenue des Champs-Élysées")
    await expect(cityInput).toHaveValue("Paris")
    await expect(postalCodeInput).toHaveValue("75008")
    await expect(countryInput).toHaveValue("France")
  })
})
