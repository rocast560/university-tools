// Long multi-page report (fixture, authored by scratchpad/make-long.mjs). Cover with variables,
// a contents list, narrative sections and twelve finding blocks with identical tables.
#set page(paper: "a5", margin: (x: 1.6cm, y: 1.8cm), footer: context [Confidential #h(1fr) #counter(page).display()])
#set text(size: 9pt)
#set heading(numbering: "1.1")
#set par(justify: true)

#let client = "{{CLIENT_NAME}}"
#let engagement = "{{ENGAGEMENT_ID}}"

#let image-placeholder(caption, path: none, height: 1.1in) = figure(
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
  #text(size: 20pt, weight: "bold")[Internal Network Assessment]

  Prepared for #client

  Engagement #engagement
]

#pagebreak()

#outline(depth: 1)

#pagebreak()

= Executive Summary

The assessment of the internal network identified two critical findings, three high findings, four medium findings and three low findings. The critical findings expose backups and monitoring data to anyone on the staff network.

The client should fix the critical findings within seven days. The other findings fit the normal maintenance cycle and are listed with a recommended owner.

= Scope and Approach

Testing covered the server subnet, the VPN gateway and the domain controllers. The team worked from a laptop on the staff network with a standard user account.

== Tools

Scanning used the usual network scanner and a web proxy. Every automated result was confirmed by hand before it entered this report.

== Limitations

The environment was in use during testing, so intrusive tests were avoided. Social engineering and physical access were out of scope.

= Findings

== Default credentials on the monitoring server

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Critical],
  [*CVSS*], [9.8],
  [*Status*], [Open],
  [*Affected host*], [mon01.corp.test],
)

The monitoring server still accepts the vendor default administrator login. Anyone on the staff network can sign in and read every host inventory record.

*Recommendation:* Change the default password and restrict the console to the management network.

#image-placeholder("Evidence for finding 1: default credentials on the monitoring server")

== Unauthenticated file share exposes backups

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Critical],
  [*CVSS*], [9.1],
  [*Status*], [Open],
  [*Affected host*], [files02.corp.test],
)

A share named backups allows anonymous read access. It holds database dumps that include customer email addresses and hashed passwords.

*Recommendation:* Require authentication on the share and move the dumps to encrypted storage.

== Missing patch for remote code execution

#table(
  columns: (1fr, 2fr),
  [*Severity*], [High],
  [*CVSS*], [8.6],
  [*Status*], [Open],
  [*Affected host*], [app03.corp.test],
)

The application server runs a library version with a public remote code execution exploit. The vendor released a fix four months ago.

*Recommendation:* Apply the vendor update and add the host to the monthly patch cycle.

== Cross-site scripting in the help desk form

#table(
  columns: (1fr, 2fr),
  [*Severity*], [High],
  [*CVSS*], [7.4],
  [*Status*], [Retest],
  [*Affected host*], [help.corp.test],
)

The subject field of the help desk form is reflected without encoding. A crafted ticket runs script in the browser of the agent who opens it.

*Recommendation:* Encode output in the ticket view and add a content security policy.

#image-placeholder("Evidence for finding 4: cross-site scripting in the help desk form")

== Session tokens do not expire

#table(
  columns: (1fr, 2fr),
  [*Severity*], [High],
  [*CVSS*], [7.1],
  [*Status*], [Open],
  [*Affected host*], [portal.corp.test],
)

Session tokens stay valid for thirty days after the last use. A stolen token gives long lived access to the account.

*Recommendation:* Expire idle sessions after fifteen minutes and rotate tokens at login.

== Directory listing enabled on the build server

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Medium],
  [*CVSS*], [5.9],
  [*Status*], [Open],
  [*Affected host*], [build04.corp.test],
)

The build server lists the contents of its artifact directory to anyone who can reach it. The listing shows internal project names and file versions.

*Recommendation:* Disable directory listing and require a login for the artifact area.

== TLS 1.0 still accepted

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Medium],
  [*CVSS*], [5.3],
  [*Status*], [Open],
  [*Affected host*], [vpn.corp.test],
)

The VPN gateway negotiates TLS 1.0 and weak cipher suites. Older clients are the only reason it remains enabled.

*Recommendation:* Disable TLS 1.0 and 1.1 and retire the clients that need them.

#image-placeholder("Evidence for finding 7: tls 1.0 still accepted")

== No account lockout on the VPN

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Medium],
  [*CVSS*], [5.3],
  [*Status*], [Retest],
  [*Affected host*], [vpn.corp.test],
)

The gateway allows unlimited login attempts. An attacker can guess passwords at several hundred requests per minute.

*Recommendation:* Lock accounts after five failed attempts and alert on repeated failures.

== Overly broad service account

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Medium],
  [*CVSS*], [4.9],
  [*Status*], [Open],
  [*Affected host*], [dc01.corp.test],
)

The reporting service account is a member of the domain administrators group. It only needs read access to one database.

*Recommendation:* Remove the account from the group and grant the minimum rights it needs.

== Missing security headers

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Low],
  [*CVSS*], [3.7],
  [*Status*], [Open],
  [*Affected host*], [portal.corp.test],
)

Responses omit the frame options and content type options headers. The omission enables clickjacking against the login page.

*Recommendation:* Set the standard security headers at the reverse proxy.

#image-placeholder("Evidence for finding 10: missing security headers")

== Server version disclosure

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Low],
  [*CVSS*], [3.1],
  [*Status*], [Open],
  [*Affected host*], [api.corp.test],
)

The server banner names the web server and its exact version. The detail helps an attacker choose an exploit.

*Recommendation:* Suppress the version string in the server configuration.

== Unencrypted internal database traffic

#table(
  columns: (1fr, 2fr),
  [*Severity*], [Low],
  [*CVSS*], [2.6],
  [*Status*], [Accepted],
  [*Affected host*], [db01.corp.test],
)

Connections between the application and the database are not encrypted. The traffic stays inside one network segment.

*Recommendation:* Enable TLS on the database listener during the next maintenance window.

= Remediation Plan

The table lists each finding with the team that owns the fix and the target date.

#table(
  columns: (2fr, 1fr, 1fr),
  table.header([*Finding*], [*Owner*], [*Target*]),
  [Default credentials on the monitoring server], [Infrastructure], [Week 1],
  [Unauthenticated file share exposes backups], [Infrastructure], [Week 1],
  [Missing patch for remote code execution], [Platform], [Week 2],
  [Cross-site scripting in the help desk form], [Applications], [Week 3],
)

= Conclusion

The two critical findings share a cause: services were deployed with their defaults and never reviewed. A short checklist for new servers would have prevented both. The remaining findings are routine and can be fixed with the patch cycle.

= Appendix: Test Accounts

The team used two accounts during the assessment. Both were disabled at the end of testing.

#table(
  columns: (1fr, 1fr),
  table.header([*Account*], [*Role*]),
  [test.user], [Standard user],
  [test.support], [Help desk agent],
)
