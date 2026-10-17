// Helpers and variables (fixture): #let helpers that generate text, {{PLACEHOLDER}} variables,
// a page header/footer set by #set, a show rule, a loop, and the image-placeholder helper.
#set page(paper: "a5", margin: (x: 1.6cm, y: 2cm), header: [Acme Corp internal review #h(1fr) Draft 3])
#set text(size: 9.5pt)
#set heading(numbering: "1.1")
#show heading.where(level: 1): it => block(above: 1.4em, below: 0.8em)[#it.body]

#let team = "{{TEAM_NAME}}"
#let reviewer = "{{REVIEWER}}"
#let due = "{{DUE_DATE}}"

#let badge(label, color) = box(
  fill: color,
  inset: (x: 5pt, y: 2pt),
  radius: 2pt,
)[#text(fill: white, size: 8pt)[#label]]

#let callout(title, body) = block(
  fill: luma(240),
  inset: 8pt,
  width: 100%,
)[*#title* \ #body]

#let image-placeholder(caption, path: none, height: 1in) = figure(
  block(
    width: 90%,
    height: height,
    fill: luma(245),
    align(center + horizon,
      text(fill: luma(120), style: "italic")[
        \[ {{TODO: Insert screenshot here}} \]
      ],
    ),
  ),
  caption: caption,
)

#align(center)[
  #text(size: 17pt, weight: "bold")[Design Review Summary]

  Owner: #team, reviewer #reviewer, due #due
]

= Overview

The #team group reviewed the storage design with #reviewer on #due. The review covered the rack layout, the cabling plan and the backup schedule.

#callout("Decision needed")[Approve the rack layout before the order closes.]

= Status

#badge("Approved", green) Rack layout.

#badge("Blocked", red) Cabling plan, waiting on the vendor quote.

#badge("In review", orange) Backup schedule.

== Action items

#for item in ("Order the rack", "Confirm the cable lengths", "Test the restore") [
  - #item
]

== Diagrams

#image-placeholder("Rack layout, front view")

#image-placeholder("Cable run between racks")

#callout("Risk")[The vendor quote may change the cable lengths.]

= Notes

Remember that the #team group meets on Thursdays. The #reviewer role rotates every quarter, so confirm the name before the next review.

Total budget: #lorem(8)

The summary above is generated, but the closing line is plain text that the author typed by hand.
