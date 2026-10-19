#!/usr/bin/env python3
"""Extract readable paragraphs from a DOCX, including text boxes.

The Wakako CV stores its content in full-page text boxes, so a plain
`docx -> markdown` conversion returns nothing. This helper walks the
`w:txbxContent` elements directly and prints one paragraph per line.

Usage:
    python3 scripts/extract_docx.py "documents/Lebenslauf_Wakako Obata 2026 2.docx"

The output is raw source text for auditing/curating data/wakako-obata.json;
it is not consumed by the build.
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"


def paragraph_text(paragraph: ET.Element) -> str:
    parts: list[str] = []

    def walk(element: ET.Element) -> None:
        # mc:Fallback repeats the same text box for older Word versions.
        if element.tag == MC + "Fallback":
            return
        if element.tag == W + "t":
            parts.append(element.text or "")
        elif element.tag == W + "br":
            parts.append("\n")
        elif element.tag == W + "tab":
            parts.append("\t")
        for child in element:
            walk(child)

    walk(paragraph)
    return "".join(parts).strip()


def text_boxes(root: ET.Element) -> list[ET.Element]:
    boxes: list[ET.Element] = []

    def walk(element: ET.Element) -> None:
        if element.tag == MC + "Fallback":
            return
        if element.tag == W + "txbxContent":
            boxes.append(element)
            return
        for child in element:
            walk(child)

    walk(root)
    return boxes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", help="path to the .docx file")
    args = parser.parse_args()

    with zipfile.ZipFile(args.docx) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))

    body = document.find(W + "body")
    if body is None:
        print("No document body found.", file=sys.stderr)
        return 1

    boxes = text_boxes(body)
    print(f"# Source: {args.docx}")
    print(f"# Text boxes: {len(boxes)}")

    for index, box in enumerate(boxes, start=1):
        paragraphs = [
            text
            for paragraph in box.findall(W + "p")
            if (text := paragraph_text(paragraph))
        ]
        if not paragraphs:
            continue
        print(f"\n## Text box {index}")
        for text in paragraphs:
            print(text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
