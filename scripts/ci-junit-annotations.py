#!/usr/bin/env python3
"""Print failing JUnit tests as GitHub annotations.

The raw Actions log blob is not always reachable (and attribution is easier to
read in the Checks API), so assertion messages are surfaced as annotations.
"""
import glob
import sys
import xml.etree.ElementTree as ET


def main(pattern: str) -> int:
    found = 0
    for path in glob.glob(pattern, recursive=True):
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError:
            continue
        for case in root.iter('testcase'):
            for failure in list(case.findall('failure')) + list(case.findall('error')):
                name = f"{case.get('classname', '?')} > {case.get('name', '?')}"
                raw = (failure.get('message') or failure.text or 'failed')
                message = ' '.join(raw.split())[:800]
                print(f"::error title=test::{name[::-1][:300][::-1]} :: {message}")
                found += 1
    if found:
        print(f"::error title=junit:: {found} failing test(s)", file=sys.stdout)
    else:
        print('::warning title=junit:: no JUnit XML found; check the report artifact')
    return 0


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '**/test-results/**/*.xml')
