# Waterfall Compact Cards Prototype Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build one dependency-free local HTML page that lets the user visually approve the AI Feeds compact masonry design at 1440px desktop and 390px mobile widths.

**Architecture:** The prototype uses two fixed-width preview canvases on one review page. Each canvas contains the same source-aware card set; CSS Grid plus a small row-span script produces equal-width masonry without changing DOM order.

**Tech Stack:** Semantic HTML, CSS container queries, inline SVG, dependency-free JavaScript.

---

### Task 1: Create the review page

**Files:**
- Create: `docs/plans/_mockups/2026-07-18-waterfall-compact-cards.html`

**Step 1: Add the page shell**

Add a neutral review header, compact specification strip, a 1440px desktop canvas, and a 390px mobile canvas.

**Step 2: Add representative cards**

Use the same X, GitHub, Product Hunt, paper, blog, podcast and ClawHub examples in both canvases. Keep source-specific identity while limiting each card to the information that remains legible at 177px.

**Step 3: Add masonry layout**

Use a single ordered grid in each canvas. Calculate `grid-row-end` spans from rendered card height and recalculate with `ResizeObserver`.

**Step 4: Add review controls**

Provide “全部、PC、移动端” controls that only change the review-page presentation. Do not simulate application behavior or add production dependencies.

### Task 2: Verify both breakpoints

**Files:**
- Test: `docs/plans/_mockups/2026-07-18-waterfall-compact-cards.html`

**Step 1: Validate the document**

Run a local static server and confirm the page loads without console errors or external network requests.

**Step 2: Capture desktop review**

Open the page at a desktop viewport and verify the 1440px preview contains five equal-width columns with independent card borders.

**Step 3: Capture mobile review**

Verify the 390px preview contains two 177px columns with 12px outer margins and a 12px gutter.

**Step 4: Check overflow and reading order**

Confirm no card content overflows and the source order in the DOM remains unchanged.

### Task 3: Hand off for visual approval

**Files:**
- Review: `docs/plans/_mockups/2026-07-18-waterfall-compact-cards.html`

**Step 1: Link the local HTML**

Return the local page and rendered screenshots for user review.

**Step 2: Hold production implementation**

Do not modify `WaterfallHome.tsx`, `WaterfallCard.tsx`, `waterfall.css`, tests, or deployment configuration until the prototype direction is approved.

