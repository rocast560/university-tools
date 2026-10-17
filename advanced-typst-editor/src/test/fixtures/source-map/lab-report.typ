// Lab report (fixture). Numbered headings, an abstract, a figure with a caption, a table of
// measurements, a list, equations and a reference list.
#set page(paper: "a5", margin: 1.7cm, numbering: "1")
#set text(size: 9.5pt)
#set heading(numbering: "1.")
#set par(justify: true)

#align(center)[
  #text(size: 16pt, weight: "bold")[ECE 2300 Lab 4: RC Filter Response]

  Roberto Castro, Section 012

  October 3
]

#heading(numbering: none)[Abstract]

This lab measured the frequency response of a first-order RC low-pass filter. The measured cutoff frequency of 1.58 kHz agrees with the calculated value to within 3 percent.

= Introduction

A low-pass filter passes low frequencies and attenuates high ones. The cutoff frequency is the point where the output falls to 70.7 percent of the input amplitude.

== Objectives

- Build a first-order RC low-pass filter.
- Measure the gain at ten frequencies.
- Compare the measured cutoff with the calculated cutoff.

= Theory

The transfer function of the filter is

$ H(s) = 1 / (1 + s R C) $

and the cutoff frequency follows from the time constant:

$ f_c = 1 / (2 pi R C) $

With R = 10 kΩ and C = 10 nF the calculated cutoff is 1.59 kHz.

= Procedure

The circuit was built on a breadboard with a 10 kΩ resistor and a 10 nF capacitor. The function generator drove the input with a 1 V peak sine wave. The oscilloscope measured the input and output amplitudes at each frequency.

#figure(
  rect(width: 70%, height: 3cm, stroke: 0.5pt)[
    #align(center + horizon)[RC low-pass schematic]
  ],
  caption: [Schematic of the RC low-pass filter],
) <fig-schematic>

= Results

@fig-schematic shows the circuit under test. Table 1 lists the measured gain at each frequency.

#figure(
  table(
    columns: 3,
    table.header([*Frequency (Hz)*], [*Vout (V)*], [*Gain (dB)*]),
    [100], [0.998], [-0.02],
    [500], [0.953], [-0.42],
    [1000], [0.846], [-1.45],
    [1580], [0.707], [-3.01],
    [5000], [0.303], [-10.37],
  ),
  caption: [Measured gain of the filter],
)

The gain fell by 3 dB at 1.58 kHz, which is the measured cutoff frequency.

= Discussion

The 3 percent difference between the measured and calculated cutoff is within the tolerance of the components. A 5 percent capacitor alone accounts for most of it.

== Sources of error

Probe capacitance of the oscilloscope adds to the filter capacitor. The function generator output impedance adds to the resistor.

= Conclusion

The filter behaved as the first-order model predicts, and the measured cutoff matched the calculation.

#heading(numbering: none)[References]

+ Sedra and Smith, _Microelectronic Circuits_, 8th edition.
+ ECE 2300L lab manual, Experiment 4.
