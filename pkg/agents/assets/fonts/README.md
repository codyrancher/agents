# Harness Terminal

The terminal font, used by `components/PodTerminal.vue` and nothing else.

It is [Cascadia Code](https://github.com/microsoft/cascadia-code) (version 2407.024,
(c) 2021 Microsoft Corporation), renamed to **Harness Terminal**, which is what the Claude
Harness portal's terminal uses. Licensed under the SIL Open Font License, which is what
allows it to be redistributed here, and which is also why it carries a different name: the
OFL requires a modified copy to be renamed.

The two weights are the ones a terminal actually asks for. They are inlined into the built
extension as data URIs rather than emitted as files, because a UMD extension has no reliable
public path of its own to fetch a file from. See the `fonts` rule in
`pkg/barn/vue.config.js`.
