# Audyt interfejsu (Impeccable audit), 2026-10-21

Zakres: `wasm/index.html` i `wasm/static/css/style.css`. Audyt statyczny: detektor Impeccable (`impeccable detect --json`),
zliczenia w kodzie i podgląd reguł CSS; aplikacji nie renderowano. Brak PRODUCT.md, więc założono aplikację telewizyjną
(Tizen, pilot i pad, tylko ciemny motyw).

**Wymiar „Dostępność" został świadomie wyłączony z audytu** (decyzja właściciela: dla tej aplikacji nie ma znaczenia).
Dlatego nie ma tu kontrastu, tekstów alternatywnych obrazków, hierarchii nagłówków ani `prefers-reduced-motion`. Detektor
zgłosił w tym obszarze 20 trafień kontrastu (czarny tekst na `#404354` i placeholder „Enter IP…"); nie były
weryfikowane i nie są ścigane.

## Wynik

| # | Wymiar | Ocena | Kluczowe ustalenie |
|---|---|---|---|
| 1 | Wydajność | 3/4 | 24 skrypty blokują render (tylko 2 z `defer`); poza tym lekko, bez zewnętrznych fontów i zapytań |
| 2 | Motywy | 1/4 | 6 zmiennych CSS zdefiniowanych, 0 użytych; 102 kolory hex i 51 `rgba` wpisane na stałe |
| 3 | Responsywność | 3/4 | Brak `@media` i szerokości >600 px (sensowne dla TV); przyciski 50×50 px |
| 4 | Spójność wykonania | 2/4 | Roboto (MDL), poświata `#efbf04`, generyczny wzorzec MDL |
| | **Razem** | **9/16** | **Akceptowalny** (po przeliczeniu na 20: ok. 11) |

Spójność wykonania: wzorzec jest jednolity (Material Design Lite, ciemne karty `#404354`, żółty akcent), ale generyczny.
To dług, nie błąd.

## Zgłoszenia

- **[P2] Tokeny kolorów nieużywane.** `#404354` powtórzone w co najmniej 8 regułach (`style.css` linie 104, 112, 121,
  132, 868, 884, 888, 933). Zmienne CSS są zdefiniowane, ale nikt ich nie używa (`var(--` 0 razy). Polecenie:
  `/impeccable document`, potem podmiana zduplikowanych kolorów na tokeny.
- **[P2] 24 skrypty synchroniczne** w `index.html` (okolice linii 608-640, `<script type="text/javascript" src=...>`),
  tylko 2 z `defer`. Opóźniają pierwsze malowanie na TV. Polecenie: `/impeccable optimize` (`defer` tam, gdzie
  kolejność wykonania na to pozwala; skrypty `platform/*.js` zależą od siebie i od `Module`, więc zmieniać ostrożnie).
- **[P3] Font Roboto** (pierwszy w stosie `style.css:7`, z MDL). Zgłoszenie detektora „overused-font"; świadomie
  zostawione.
- **[P3] Przewijanie nazw gier i hostów** (2 reguły `.host-text` / `.game-text` na `:hover`/`:focus`, `style.css`).
  Detektor nazywa to marquee; działa tylko na fokusie i służy do pokazania długich nazw, więc zostaje.
- **[P3] Poświata `#efbf04`** wokół przycisku aktualizacji (`style.css:128, 133`, `box-shadow` bez przesunięcia).
  Zgłoszenie „dark-glow"; zostawione jako element tożsamości.

## Co działa

- Wszystko jest lokalne: brak fontów z sieci i zewnętrznych zapytań.
- `lang` i `viewport` są ustawione; fokus ma ok. 80 reguł `:focus`, więc nawigacja pilotem jest widoczna.
- Cele dotykowe 50×50 px i brak sztywnych szerokości powyżej 600 px.
- Niewiele `will-change` (3), 2 animacje `@keyframes`, 7 przejść.

## Kolejność prac (jeśli kiedyś)

1. `/impeccable document` (spisać tokeny), potem zamiana powtórzonych kolorów.
2. `/impeccable optimize` (`defer` dla bezpiecznych skryptów).
3. `/impeccable polish` na koniec.
