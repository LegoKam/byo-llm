# BYO LLM: author guide

BYO LLM writes and rewrites page content with the AI model your organisation uses. It
works on what you have selected in the document, and nothing changes until you say so.

## Open it

Open a page in the Experience Workspace editor and choose **BYO LLM** in the library. If
it says no LLM is connected yet, ask your site admin.

## Rewrite something

1. Select the content in the document: a sentence, a paragraph, a heading, a list.
   The panel shows what it picked up under **Selection**. If you changed the selection
   and the panel did not notice, use the refresh arrow.
2. Choose a quick action:
   - **Improve**: clearer and tighter, same meaning and length.
   - **Shorten**: about half the length.
   - **Expand**: about twice the length, without adding new facts.
   - **Fix grammar**: spelling, grammar and punctuation only.
   - **Summarise**: one short paragraph.
   - **Translate…**: into the language you pick.

   Or type your own instruction, for example "Rewrite this for first-time visitors",
   and choose **Generate** (or press Cmd/Ctrl + Enter).
3. Read the result in the panel.
4. Choose **Replace selection** to put it into the document. Undo in the editor works
   as usual.

## Write something new

Put the cursor where the content should go, without selecting anything. Describe what
you want and choose **Generate**. Then choose **Insert at cursor**.

## Give it context

Choose **Attach files**, or drag files onto the panel, to give the model material to
work from: a product brief, a price list, a screenshot.

- Text files: txt, md, csv, json, html and similar, up to 1 MB each.
- Images: png, jpg, webp, gif.
- PDF, if the selected model supports it. The panel tells you when it does not.
- Up to 5 files. They stay attached until you remove them or close the panel.

Files are sent to the model with your request. They are not saved in Experience
Workspace.

## Not quite right?

- **Refine**: type what to change ("more formal", "mention the price") next to the
  result. The model revises its last answer.
- **Try again**: asks again with the same request.
- **Copy**: copies the result so you can paste it elsewhere.
- **Cancel**: stops a request that is taking too long.

## Choose a model

If your admin has connected more than one model, pick one at the top of the panel. The
panel remembers your choice.

## Good to know

- The model can be wrong. Check facts, figures, names and links before you publish.
- What you select, type and attach is sent to the model your organisation configured.
  Follow your organisation's rules about what may be shared with it.
- If you select only part of a paragraph, plain results replace just that part. Results
  with formatting, such as bold or links, are inserted as their own paragraph.
- Images in your selection are kept. The model cannot add new images.
