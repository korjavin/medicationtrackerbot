# Brief: BMI on the weight graph

Read `ui_kits/app-v2/README.md` (kit rules 1–8) and `navigation.html` N3 (Health segments: range above the chart). Work at 390×844, dark only, in the `wg-*` kit. Output: `ui_kits/app-v2/screens-bmi.html`.

**What it does.** Standard adult BMI = kg / m². The user enters a height once. Health → Weight then shows the current BMI and its WHO band, and the weight chart shows where the band borders fall at that height (converted to kg or lb). Bands are WHO only: under 18.5 · 18.5–24.9 · 25–29.9 · 30–34.9 · 35–39.9 · 40 and over. Show one line wherever BMI appears: "Adult ranges; not meant for under-18s." In ED-safe mode, BMI, the bands and the nudge are all hidden; no frame needed.

**Today's chart** (`web/static/js/components/wg-weight-chart.js`): a custom SVG with an Actual line, a dashed Goal line, a Plan line, a trend line, guides and y-ticks. Its legend reads Actual / Plan / Goal. The current-weight badge sits at the top of the chart panel. The y-axis fits the data plus the goal.

**Screens wanted**
- **BM1 · Health → Weight with BMI.** The chart with band borders, plus the BMI read-out ("BMI 24.3 · Healthy range" or similar) beside or under the current-weight badge. Variants: a user near a border (24.8), and a user above 30.
- **BM1 · no height.** The same page without BMI, showing one quiet nudge: "Add your height to see BMI" → the height field. Say how it is dismissed and where it lives after that.
- **BM2 · Height field.** In Settings, near the weight unit: cm, or ft + in. No native select or number spinner as the visible control (rule 7). Include the "Adult ranges" line.
- **BM3 · Goal below BMI 18.5.** The weight-goal editor with a target that falls under 18.5 at this height. It is a warning, not a block.

**Open questions; please review critically**
1. **Lines or shading?** The chart already has three lines (Actual, dashed Goal, Plan) plus a trend line. My lean: faint horizontal bands with a small edge label, no extra strokes, so nothing can be mistaken for the goal.
2. **The y-axis.** Do borders outside the data range stretch the axis? My lean: no. Show only the bands the data range crosses, and label the nearest border that is off-chart at the edge.
3. **Colour and words.** Kit rule 4 allows status only through ok / warn / danger. Painting "obesity" red reads as a judgement on someone's body. My lean: neutral tints, with only the 18.5–24.9 band marked (ok). The words would be "Healthy range" and "Above / Below healthy range", or the WHO terms (Underweight, Normal, Overweight, Obesity I–III). Propose one set.
4. **Legend.** Does the band get a legend entry, or does the edge label alone explain it?
5. **The nudge.** Is it on the Weight page, the Today weight tile, or both? It must not compete with the page's one sun control.
