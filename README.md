# GAERU storefront

A responsive Vietnamese storefront prototype inspired by Apple's product-led layouts. It includes:

- `index.html` — homepage and featured products
- `shop.html` — searchable, filterable catalog
- `product.html?id=k9|m3|p01|g1` — product details
- `cart.html` — persistent local cart with quantity updates and removal
- `checkout.html` — safe handoff to the official GAERU product pages
- `account.html` — account entry points to the existing GAERU account service
- Shared navigation includes an animated product menu, live product search and a quick-view cart drawer with quantity controls.

The prototype uses product descriptions, imagery, price ranges and product links currently shown on GAERU.com. Cart quantities are saved in browser local storage. Adding a product opens the quick-view cart; its item controls update the shared cart and header count. This preview cart does not sync with WooCommerce. Totals use each product's starting price and are estimates; variants, inventory, shipping, account authentication, order creation and payment are not connected. The checkout handoff links each item to its official GAERU product page so customers can choose a current variant and purchase through the existing store. It does not collect personal details or create orders in the prototype.

Serve the repository as static files with a local HTTP server and open `index.html`. No build step or dependency installation is required.
