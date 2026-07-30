---
name: Wandergeek
colors:
  surface: "#0f2522"
  surface-dim: "#0f2522"
  surface-bright: "#1F3F3B"
  surface-container-lowest: "#0a1917"
  surface-container-low: "#18302d"
  surface-container: "#254844"
  surface-container-high: "#2d544f"
  surface-container-highest: "#3c6b65"
  on-surface: "#F4FBF7"
  on-surface-variant: "rgba(244, 251, 247, 0.72)"
  inverse-surface: "#F4FBF7"
  inverse-on-surface: "#0f2522"
  outline: "rgba(255, 255, 255, 0.12)"
  outline-variant: "rgba(255, 255, 255, 0.06)"
  surface-tint: "#56AC8A"
  primary: "#56AC8A"
  on-primary: "#0F5042"
  primary-container: "#2D544F"
  on-primary-container: "#8FC5BC"
  inverse-primary: "#9CE4CC"
  secondary: "#FBBD0D"
  on-secondary: "#E5A600"
  secondary-container: "rgba(251, 189, 13, 0.14)"
  on-secondary-container: "#FFD870"
  tertiary: "#C6553A"
  on-tertiary: "#F4FBF7"
  tertiary-container: "rgba(198, 85, 58, 0.18)"
  on-tertiary-container: "#F3A693"
  error: "#C6553A"
  on-error: "#F4FBF7"
  error-container: "rgba(198, 85, 58, 0.18)"
  on-error-container: "#F3A693"
  primary-fixed: "#8FC5BC"
  primary-fixed-dim: "#56AC8A"
  on-primary-fixed: "#0F5042"
  on-primary-fixed-variant: "#0f2522"
  secondary-fixed: "#FFE492"
  secondary-fixed-dim: "#FBBD0D"
  on-secondary-fixed: "#E5A600"
  on-secondary-fixed-variant: "#A06E00"
  tertiary-fixed: "#F3A693"
  tertiary-fixed-dim: "#C6553A"
  on-tertiary-fixed: "#A8442C"
  on-tertiary-fixed-variant: "#803020"
  background: "#0f2522"
  on-background: "#F4FBF7"
  surface-variant: "#254844"
typography:
  display:
    fontFamily: JetBrains Mono
    fontSize: 24px
    fontWeight: "600"
    lineHeight: 32px
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 20px
    fontWeight: "600"
    lineHeight: 28px
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 18px
    fontWeight: "500"
    lineHeight: 24px
  body-lg:
    fontFamily: Space Grotesk
    fontSize: 16px
    fontWeight: "400"
    lineHeight: 24px
  body-md:
    fontFamily: Space Grotesk
    fontSize: 14px
    fontWeight: "400"
    lineHeight: 20px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: "500"
    lineHeight: 16px
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 10.5px
    fontWeight: "500"
    lineHeight: 14px
    letterSpacing: 0.05em
rounded:
  sm: 6px
  DEFAULT: 10px
  md: 12px
  lg: 14px
  xl: 18px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
components:
  card:
    backgroundColor: "{colors.surface-container}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  card-inset:
    backgroundColor: "{colors.surface-container-highest}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  badge-success:
    backgroundColor: "rgba(86, 172, 138, 0.18)"
    textColor: "#9CE4CC"
    typography: "{typography.label-sm}"
    rounded: "{rounded.DEFAULT}"
    padding: "{spacing.xs}"
  badge-warning:
    backgroundColor: "rgba(251, 189, 13, 0.14)"
    textColor: "#FFD870"
    typography: "{typography.label-sm}"
    rounded: "{rounded.DEFAULT}"
    padding: "{spacing.xs}"
  badge-error:
    backgroundColor: "rgba(198, 85, 58, 0.18)"
    textColor: "#F3A693"
    typography: "{typography.label-sm}"
    rounded: "{rounded.DEFAULT}"
    padding: "{spacing.xs}"
---

## Brand & Style

The Wandergeek design system establishes a focused, tactical, and slightly retro-futuristic environment. It uses a deep-teal "stage" background with "glossy tiles" resting upon it. The visual language conveys precision, depth, and data-centric utility without being sterile, evoking the feeling of an advanced heads-up display or technical readout.

The aesthetic relies on dark mode natively, with light elements functioning as glowing accents and illuminated text. It utilizes physical metaphors like "ink," "paper," and "clay" alongside purely digital textures like "gloss" and translucent borders to create a tangible but deeply electronic experience.

## Colors

The Wandergeek palette is built around a profound, dark teal environment punctuated by vibrant, warm accents.

- **Background Stage:** Deep Teal (`#0f2522`) sets the moody, immersive foundation.
- **Surfaces:** Card backgrounds use a lighter teal (`#254844`) with inset elements shifting slightly darker or utilizing gloss gradients for depth.
- **Accents:**
  - **Sage/Mint:** Used for primary actions, nominal statuses, and general data representation. It provides a crisp, legible green-blue contrast.
  - **Sun (Yellow/Gold):** Draws the eye to warnings, active states, or primary highlights.
  - **Clay (Orange/Red):** Reserved for alerts, errors, and critical destructive actions.
- **Text (Foregrounds):** Defined by varying opacities of "Paper" (a very light, slightly cool white: `#F4FBF7`), ranging from 100% for primary data down to 32% for subtle hints.

## Typography

The typography strategy pairs a warm, characterful UI sans-serif with a crisp, technical monospaced font for data and labels.

- **UI Font:** Space Grotesk is used for headlines, body copy, and narrative text. It provides legibility while contributing to the slightly technical, modern aesthetic.
- **Data & Labels:** JetBrains Mono is used for numbers, metrics, tags, button labels, and small UI elements. This reinforces the "readout" feel and ensures tabular figures align perfectly.

## Layout & Spacing

Layouts favor structured, card-based groupings floating above the dark stage.

- **Containers:** Content is typically housed within `14px` rounded cards with `14px` inner padding.
- **Rhythm:** Spacing follows a regular scale, utilizing tighter gaps (4px-8px) for related data points and generous margins (24px-32px) to separate major sections.

## Elevation & Depth

Depth is not just indicated by darkness; it uses the "Gloss Material" concept, creating a sense of refractive physical layers.

- **Gloss Backgrounds:** Cards often feature subtle, dual-layer linear gradients (e.g., from a semi-transparent white at the top to a solid teal at the bottom) to simulate a glassy sheen over a dark surface.
- **Shadows:** Complex, multi-layered shadows combine a soft ambient drop shadow with sharp inset highlights (e.g., `inset 0 1px 0 rgba(255, 255, 255, 0.22)`) to give elements a distinct, raised edge, catching an imaginary light source from above.
- **Insets:** Recessed areas (like number fields or secondary information panels) use reverse gradients and subtle inner shadows to appear carved into the main surface.
- **Hairline Borders:** `rgba(255, 255, 255, 0.06)` is used extensively to define the edges of shapes without drawing heavy lines.

## Shapes

Shapes balance the technical feel with approachability through consistent rounding.

- **Cards:** The foundational shape uses `14px` rounded corners.
- **Buttons and Icons:** Action elements use a slightly tighter `10px` or `12px` radius.
- **Tags:** Small status indicators are fully rounded (pill-shaped) or use the standard `10px` radius depending on the context.

## Components

### Gloss Cards

The central container element. It features a deep teal base color overlaid with a subtle white-to-transparent vertical gradient and is lifted off the stage via a combination of a soft drop shadow and a sharp, white inset top-edge highlight.

### Inset Panels

Used within Gloss Cards to group secondary information or house inputs. They utilize a darker background gradient and an inner shadow to visually recess them into the card surface.

### Tags & Status Badges

Small indicators built with a translucent background color (e.g., 18% opacity of the base color), a solid contrasting text color, and a slightly stronger translucent border. They utilize JetBrains Mono at a small scale (10.5px) for a precise, technical look.

### Action Elements

Buttons and interactive icons use the Mint or Sun accent colors. They maintain the technical feel by utilizing JetBrains Mono for their labels.
