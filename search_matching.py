"""Deterministic metadata matching. Scores order keyword evidence, not probabilities."""
import re
import unicodedata


def compact(value):
    return "".join(c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum())


class KeywordMatcher:
    def __init__(self, text):
        self.full = compact(text)
        value = unicodedata.normalize("NFKC", text).strip().casefold()
        value = re.sub(r"^(?:帮我找|我想搜|搜索|查找|找一下)\s*", "", value)
        reduced = re.sub(r"(?:的)?(?:图片|模型|贴图)$", "", value).strip()
        value = reduced or value
        self.terms = list(dict.fromkeys(compact(term) for term in re.split(r"[\W_]+", value) if compact(term)))
        self.phrase = compact(value)

    def match(self, fields):
        # fields: (display reason, text, priority); larger priority is stronger metadata evidence.
        normalized = [(reason, compact(value), priority) for reason, value, priority in fields if value]
        best, reasons = 0, []
        for reason, value, priority in normalized:
            if self.full and self.full in value:
                score = priority + (10 if self.full == value else 0)
            elif self.phrase and self.phrase in value:
                score = priority
            else:
                continue
            if score > best:
                best, reasons = score, [reason]
            elif score == best and reason not in reasons:
                reasons.append(reason)
        if best:
            return best, reasons
        # Space-separated terms may occur in different fields. Require every term.
        matches = []
        for term in self.terms:
            hit = [(priority, reason) for reason, value, priority in normalized if term in value]
            if not hit:
                return 0, []
            matches.append(max(hit))
        if matches:
            return min(priority for priority, _ in matches), list(dict.fromkeys(reason for _, reason in matches))
        return 0, []
