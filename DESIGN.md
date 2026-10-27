# Common Table POS UI direction

## Product context

Common Table is a touch-first cashier and outlet management app for busy cafes and quick-service restaurants. The cashier's primary flow is to choose dine-in or takeaway, find menu items, review the order, send it to the kitchen, and record tender. Controls and prices need to remain easy to scan while standing at a counter.

## Visual direction

- Use a warm, quiet neutral canvas with white work surfaces and one restaurant-green action color.
- Use charcoal for primary text and muted green-gray for supporting copy. Reserve amber for waiting or offline states and red for errors or destructive actions.
- Keep the existing Common Table green identity, rounded card language, and Lucide icons. Avoid decorative gradients and ornamental dashboard cards.
- Keep information density useful for the counter: a clear page title, compact context, readable menu tiles, and a persistent order summary on wide screens.

## Interaction and accessibility

- Target at least 44px height for primary touch controls where the layout allows it.
- Keep essential text at 12px or larger; menu names, prices, and primary controls should be at least 14px.
- Preserve a visible keyboard focus ring. State should be communicated with text and shape as well as color.
- Respect `prefers-reduced-motion` and avoid motion that delays a cashier action.
- Keep existing routes, navigation labels, form names, and order behavior stable during visual redesigns.

## Layout

- Keep the order summary beside the menu on laptop and landscape tablet widths; stack the regions on narrow screens.
- Support a 320px minimum viewport without forcing horizontal page scrolling.
- Let long category labels and menu names wrap. Keep category filters horizontally scrollable rather than shrinking their labels.

## Current scope

The cashier POS surface in `apps/web/src/App.tsx` and shared web styles in `apps/web/src/style.css` are the first implementation of this direction. Manager, inventory, reports, and kitchen screens should adopt the same tokens and interaction rules as they are redesigned.
