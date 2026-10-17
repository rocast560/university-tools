// Prose with typography the renderer rewrites (fixture): smart quotes, dashes, ellipses,
// emphasis, raw text, links, escapes, a footnote, and sentences that markup splits.
#set page(paper: "a5", margin: 1.8cm)
#set text(size: 10pt, lang: "en")
#set par(justify: true)

= Notes on the Release

The team said it's "ready" -- but the checklist wasn't finished. Nobody argued with the "go" decision, and the build shipped on Friday.

The range 10--20 ms is typical, and the worst case---a cold cache---took 85 ms. Wait for it... then retry.

== What changed

We *replaced the parser* and kept the _public interface_ the same. The `normalize()` call now runs once per request instead of once per field.

The release notes live at #link("https://example.test/notes")[the project page], and the old notes are archived there too.

Some words need an escape: the price is \$5, the tag is \#draft, and the path is C:\\temp.

== Open issues

Two issues remain. The first is a flaky test in the upload path; the second is a slow query in the report page.#footnote[Both are tracked in the issue board under the label "release".]

The flaky test fails about one run in forty. Rerunning the job usually clears it, but the failure still blocks the merge queue.

Another paragraph that repeats a phrase: the build shipped on Friday, and the build shipped again on Monday after the fix.

= Next Steps

The plan, in order:

+ Fix the flaky upload test.
+ Add an index for the report query.
+ Write the "what went wrong" summary.

Nothing here is final -- the plan will change as the facts do.
