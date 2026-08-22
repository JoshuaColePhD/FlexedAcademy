import re
import sys
import urllib.request
from bs4 import BeautifulSoup

URLS = {
    "Math": "https://www.act.org/content/act/en/college-and-career-readiness/standards/mathematics-standards.html",
    "Reading": "https://www.act.org/content/act/en/college-and-career-readiness/standards/reading-standards.html",
    "Science": "https://www.act.org/content/act/en/college-and-career-readiness/standards/science-standards.html"
}

BANDS = {
    "2": "13-15",
    "3": "16-19",
    "4": "20-23",
    "5": "24-27",
    "6": "28-32",
    "7": "33-36"
}

def clean_text(text):
    return re.sub(r"\s+", " ", text).replace("\u2013", "-").replace("\u2014", "-").strip()

def scrape_subject(subject_name, url):
    print(f"Scraping {subject_name}...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        html = urllib.request.urlopen(req).read().decode('utf-8')
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return

    soup = BeautifulSoup(html, 'html.parser')
    
    # Structure we want to build:
    # strand_name -> band -> list of (code, desc)
    data = {}

    # We will search for all <tr> tags. If a <tr> has a <th> as its first child, that's likely a Strand.
    for table in soup.find_all('table'):
        for tr in table.find_all('tr'):
            # The first cell might be a <th> or <td>. Let's find the first cell.
            cells = tr.find_all(['th', 'td'])
            if not cells:
                continue
            
            # The first cell is usually the strand name, if it doesn't contain "Score Range" or "Topics"
            strand_raw = clean_text(cells[0].get_text())
            if "Score Range" in strand_raw or "Topics in the flow" in strand_raw or "Topics in the flow" in strand_raw:
                continue
            
            strand_name = strand_raw.strip()
            
            if strand_name not in data:
                data[strand_name] = {b: [] for b in BANDS.values()}
            
            # Now extract all standards from the remaining cells
            for cell in cells[1:]:
                for p in cell.find_all('p'):
                    b_tag = p.find('b')
                    if not b_tag:
                        continue
                    code_raw = clean_text(b_tag.get_text())
                    
                    code_match = re.match(r"^([A-Za-z]+)\s*(\d{3})\.?$", code_raw)
                    if code_match:
                        prefix = code_match.group(1)
                        number = code_match.group(2)
                        code = f"{prefix} {number}"
                        
                        desc_raw = p.get_text()
                        desc = clean_text(desc_raw.replace(b_tag.get_text(), "", 1)).strip()
                        
                        level = number[0]
                        band = BANDS.get(level)
                        if band:
                            data[strand_name][band].append((code, desc))
                    else:
                        code_match2 = re.match(r"^([A-Za-z]+)\s*(\d{3})\.?(.*)$", clean_text(p.get_text()))
                        if code_match2:
                            prefix = code_match2.group(1)
                            number = code_match2.group(2)
                            code = f"{prefix} {number}"
                            desc = clean_text(code_match2.group(3)).strip()
                            level = number[0]
                            band = BANDS.get(level)
                            if band:
                                data[strand_name][band].append((code, desc))
                            
    # Write to markdown
    filename = f"data/raw/act-{subject_name.lower()}-standards.md"
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(f"## {subject_name}\n\n")
        
        for strand, bands in data.items():
            if not any(bands.values()):
                continue
                
            f.write(f"### {strand}\n\n")
            for band in ["13-15", "16-19", "20-23", "24-27", "28-32", "33-36"]:
                stds = bands[band]
                if stds:
                    f.write(f"**{band}**\n")
                    for code, desc in stds:
                        f.write(f"- {code}. {desc}\n")
                    f.write("\n")
                    
    print(f"Saved {filename}")

if __name__ == "__main__":
    for subj, url in URLS.items():
        scrape_subject(subj, url)
