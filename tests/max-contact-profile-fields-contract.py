import pathlib
import re
import unittest


SOURCE = pathlib.Path(__file__).parent.parent / "max_service" / "app.py"


class MaxContactProfileFieldsContract(unittest.TestCase):
    def setUp(self):
        self.source = SOURCE.read_text(encoding="utf-8")
        start = self.source.index("def serialize_contact_profile")
        end = self.source.index("\ndef is_direct_dialog", start)
        self.function = self.source[start:end]

    def test_only_provider_returned_public_fields_are_projected(self):
        self.assertIn('getattr(contact, "phone", "")', self.function)
        self.assertIn('getattr(contact, "country", "")', self.function)
        self.assertIn('getattr(contact, "link", "")', self.function)
        self.assertNotIn("get_users_by_phone", self.function)
        self.assertNotIn("search_by_phone", self.function)

    def test_phone_and_link_are_validated_before_they_reach_the_ui(self):
        self.assertRegex(self.function, r"7 <= len\(phone_digits\) <= 15")
        self.assertIn('re.fullmatch(r"[0-9+().\\-\\s]+", raw_phone)', self.function)
        self.assertIn('parsed_link.scheme == "https"', self.function)
        self.assertIn('not parsed_link.username', self.function)
        self.assertIn('not parsed_link.password', self.function)

    def test_profile_labels_are_stable_for_the_shared_ui(self):
        for label in ("ID MAX", "Телефон", "О себе", "Страна", "Ссылка профиля"):
            self.assertIn(f'"label": "{label}"', self.function)


if __name__ == "__main__":
    unittest.main()
