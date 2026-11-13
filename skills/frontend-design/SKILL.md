---
name: frontend-design
description: Use for any work the user will look at - web pages, components, layouts, styling, dashboards, landing pages, UI polish. Covers design decisions and the look-critique-fix loop with the screenshot tool.
---

# Frontend design

Good interface work is mostly decisions made before the code and a habit of looking at the result. You can do both: decide first, then use the `screenshot` tool to see what you built and fix what looks wrong.

## 1. Decide before you write

If the project already has a design system, tokens, or a component library, use them and match the surrounding screens. Do not introduce a second visual language.

If you are starting fresh, write down (in a sentence or two, to the user) the choices below before writing code. A page with a point of view beats a page that avoids mistakes.

- **Who is it for and what should it feel like?** Calm and editorial, dense and technical, playful, premium. Pick one; let it drive everything else.
- **Type.** One family for text; a second only for display or code. Set a scale and stay on it (for example 12, 14, 16, 20, 24, 32, 48). Body text 16px or more, line-height about 1.5; headings tighter (1.1-1.25) with slightly negative letter-spacing when large. Lines of prose 45-75 characters wide.
- **Space.** One spacing scale (4, 8, 12, 16, 24, 32, 48, 64, 96). More space between groups than inside them: that difference is what makes structure visible. When in doubt, add space around the most important thing.
- **Color.** Mostly neutrals (a tinted grey scale, not pure grey), one accent used sparingly for the primary action and key highlights, plus semantic colors for success, warning, error. Text contrast at least 4.5:1. Define colors as variables once. Support dark mode with its own surface and text values rather than inverting.
- **Hierarchy.** Each screen has one most important thing. Make it win through size, weight, and space - not by making everything bold. Secondary information gets a quieter color, not just a smaller size.

## 2. Build it properly

- Lay out with flex or grid and `gap`; avoid magic margins. Align to a shared grid; ragged edges read as careless.
- Design every state, not only the happy one: hover, focus (visible focus ring), active, disabled, loading, empty, error, and long content (a 60-character name, 0 items, 10,000 items).
- Responsive from the start: check 390px and 1280px wide at least. Nothing scrolls sideways; tap targets at least 44px.
- Depth with restraint: one or two shadow levels, soft and low-contrast; consistent corner radius (pick a small set, such as 6 and 12). Borders 1px in a color close to the surface.
- Motion is brief (150-250ms), eased, and explains a change. Respect `prefers-reduced-motion`.
- Use real content. Realistic names, numbers and copy expose layout problems that "Lorem ipsum" hides. Write short, specific labels ("Save changes", not "Submit").
- Semantic HTML, labelled inputs, alt text, keyboard reachable. Accessibility problems are design bugs.

## 3. Avoid the generic look

These are the marks of an interface nobody decided on. Leave them out unless the user asks:

- purple-to-blue gradients on white, gradient text, glowing blobs;
- everything centered, every block a rounded card with a drop shadow;
- emoji as icons; icons of mixed styles and weights;
- three identical feature cards under a hero with a vague headline;
- equal spacing everywhere, so nothing groups;
- four or more accent colors; pure black on pure white.

## 4. Look, critique, fix

After the first working version, and again after each round of changes:

1. Take a `screenshot` at 1280 wide, and one with `mobile: true`. If the page needs a dev server, start it in the background first.
2. Look at the image as a critical designer seeing it for the first time, and answer honestly:
   - Where does the eye go first? Is that the most important thing?
   - Is anything misaligned, cramped, touching an edge, or orphaned on its own line?
   - Is the spacing rhythm consistent? Do related things sit together?
   - Is any text too small, too low in contrast, or too long a line?
   - Does it look like a deliberate design, or like a default template?
   - On mobile: does anything overflow, shrink too far, or stack in a strange order?
3. Fix the two or three biggest problems, then screenshot again. Stop when a further round would change details nobody would notice. Two or three rounds are usually enough.

Tell the user what you saw and what you changed. If you could not take a screenshot (no browser found), say so and say that the visual result is unverified.
