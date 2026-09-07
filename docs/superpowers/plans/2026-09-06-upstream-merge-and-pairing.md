# Scalenie upstream v1.16.0 i przywrócenie oczekiwania na PIN

> **For agentic workers:** po zgodzie użytkownika użyć `superpowers:executing-plans` i realizować zadania po kolei. Ten dokument nie upoważnia do rozpoczęcia implementacji.

**Goal:** Dodać zmiany brightcraft/moonlight-tizen do v1.16.0, zachować lokalne poprawki TV i przywrócić parowanie bez krótkiego limitu na wpisanie PIN-u.

**Architecture:** Scalenie trójstronne względem zweryfikowanej bazy zawartości v1.13.1, na osobnej gałęzi integracyjnej. Zachować lokalną obsługę czasu życia operacji, anulowania, audio/wideo i diagnostyki. Nowy Web Audio dołączyć jako opcję obok domyślnego EMSS. Oczekiwanie na PIN otrzyma osobną politykę HTTP.

**Tech Stack:** C/C++, Samsung WASM/EMSS, Emscripten 1.39.4.7, JavaScript, jQuery 2.2.0, Tizen Studio 6.1, Docker, Node, natywne testy C/C++.

**Spec:** Żądanie użytkownika z 2026-09-06 oraz ustalenia i kryteria poniżej. Status: analiza i propozycja do zatwierdzenia; kod aplikacji nie został zmieniony.

## Ograniczenia

- Rozpoczęcie zmian w kodzie dopiero po wyraźnej zgodzie użytkownika.
- Zachować także poprawki zawarte w pierwszym lokalnym snapshocie, nie tylko późniejsze commity.
- Nie przepisywać istniejącej historii ani nie zastępować całych konfliktujących plików wariantem upstream/local.
- Zachować hosty, client ID, certyfikaty parowania, ustawienia i logi. Nowe ustawienia otrzymują wartości domyślne wyłącznie, gdy brak zapisanej wartości.
- Zachować aktualny profil zgodności: `required_version=5.5`, jQuery 2.2.0 i Samsung Emscripten 1.39.4.7. Telewizor z Tizen 9 nadal jest podstawowym celem weryfikacji. Starszy dokument `docs/tizen-9-build.md` opisuje również wcześniejszy, później wycofany profil 9.0/jQuery 4; nie traktować jego początku jako aktualnej konfiguracji.
- Zachować domyślnie wyłączone eksperymentalne RFI oraz istniejącą zapisaną wartość użytkownika.
- Nie przełączać automatycznie audio z EMSS na Web Audio i nie wymuszać Game Mode na TV.
- Nie usuwać ogólnych limitów HTTP: zmiana dotyczy oczekiwania na parowanie.
- Na etapie implementacji przygotować osobny WGT do testów; nie nadpisywać jedynego dotychczasowego artefaktu. Instalacja na TV i publikacja nie były częścią tej analizy.

## Zweryfikowany stan na 2026-09-06

| Element | Ustalenie |
| --- | --- |
| Lokalne repo | `D:\Projects\moonlight-tizen-master` |
| Gałąź i HEAD | `tizen9-reliability-fixes`, `31666b21aa73928a224b3a8a8e67f0e35a87cd98` |
| Historia lokalna | 46 commitów: snapshot `7883348` i 45 późniejszych |
| Remotes | Brak skonfigurowanych remote |
| Początkowy stan roboczy | Brak zmian śledzonych; istniejący nieśledzony `wasm/static/js/jquery-2.2.0.min.js` |
| Upstream master/tag v1.16.0 | `fecbc67b1e1175e893f090a4bc9e7c269adb921e` |
| Baza porównania zawartości | v1.13.1, `9ce4284b4c42a634bddb7be199ea06042fa4afde` |
| Relacja historii | `git merge-base master local-audit` nie znalazł wspólnego przodka |
| Snapshot a v1.13.1 | Różnice w 37 plikach, obejmujące już lokalną diagnostykę, video timing, kolejkę RTP i obsługę logów w UI |
| Aktualne lokalne HEAD a v1.13.1 | Różnice w 122 plikach, łącznie z dokumentacją/testami |
| Upstream v1.13.1 → v1.16.0 | 167 commitów w grafie, 32 zmienione pliki; nie oznacza to 167 niezależnych funkcji |
| Wspólne miejsca zmian | 16 plików; symulacja wykazała konflikty tekstowe w 12 |
| Biblioteki | Brak zmian upstream w `moonlight-common-c`, `opus` i `libgamestream` między tymi tagami |

Upstream pobrano do osobnego repo bare w katalogu tymczasowym. Lokalne referencje zaimportowano do tej kopii. Symulacja `git merge-tree --write-tree --name-only --merge-base=v1.13.1 local-audit master` operowała tylko na obiektach w kopii, bez checkoutu i bez scalenia lokalnej gałęzi.

### Co wnosi upstream

- v1.14.0: tłumaczenia UI i komunikatów backendu, wybór języka, automatyczne wykrywanie języka i nowa sekcja ustawień UI. Dostarczone locale: en-US i pt-BR; brak gotowego polskiego tłumaczenia.
- v1.14.1: ostrzeżenia dotyczące wysokiego FPS i surround, wariant pakowania ForceGM, synchronizacja tłumaczeń i lepsze wykorzystanie cache SDK w Dockerze.
- v1.15.0: Smart Hub Preview, deep links, zachowanie kafelków offline, naturalne sortowanie aplikacji, poprawki odtwarzania ustawień i wyścigów pobierania okładek.
- v1.16.0: opcjonalny backend Web Audio, regulowany jitter buffer, ustawienia zależne od backendu, poprawki przełączników, resetu ustawień, okładek i pollingu hostów.
- Smart Hub Preview jest według upstream funkcją Tizen 5.5–6.0. W wersji dla TV z Tizen 9 należy zachować sprawdzanie dostępności API i bezpieczne zakończenie usługi na niewspieranym urządzeniu; nie obiecywać kafelków na tym TV.

Źródło zakresu: [CHANGELOG przypięty do analizowanego SHA](https://github.com/brightcraft/moonlight-tizen/blob/fecbc67b1e1175e893f090a4bc9e7c269adb921e/CHANGELOG.md). Potwierdzono także rzeczywiste różnice plików, a nie tylko opisy wydań.

### Konflikty i sposób zachowania lokalnych zmian

| Obszar | Pliki | Zasada integracji |
| --- | --- | --- |
| Start/stop streamu i most JS–WASM | `wasm/main.cpp`, `wasm/moonlight_wasm.hpp`, `wasm/platform/messages.js`, `wasm/platform/index.js` | Dołączyć `audioBackend` i `audioJitterMs` do wszystkich zgodnych sygnatur, zachować `speculativeRfi`, request ID, anulowanie i kontrolę generacji operacji. |
| Audio | `wasm/auddec.cpp`, nowy `wasm/platform/audio.js` | Zachować lokalne korekty synchronizacji, liczenie PLC i diagnostykę w EMSS; dołączyć dekodowanie/scheduler Web Audio i sprzątanie po sesji. |
| Gotowość odtwarzacza | `wasm/wasmplayer.cpp` | Zachować epoki i ograniczone oczekiwanie na otwarcie torów. Dla Web Audio nie tworzyć i nie oczekiwać toru audio EMSS. Nadal czekać na tor wideo; nie przywracać uzależnienia startu od samego callbacku `Play()`. |
| UI i diagnostyka | `wasm/index.html`, `wasm/platform/index.js`, `wasm/platform/navigation.js`, `wasm/static/css/style.css` | Połączyć i18n i nowe ustawienia z logami, przyciskami sesji, RFI i obsługą pilota. |
| Hosty, okładki i żądania | `wasm/static/js/utils.js`, `wasm/static/js/mdns-browser/main.js` | Dołączyć naprawę adresów bazowych i fallback lokalnego IP, zachować ograniczony scanner i izolowane żądania. Wszystkie nowe `openUrl` muszą przekazywać lokalny argument timeout/politykę. |
| Pakowanie | `Dockerfile`, `.github/workflows/release-development.yml`, `.github/workflows/release-stable.yml`, `CMakeLists.txt` | Połączyć cache SDK i ForceGM z lokalnym pobieraniem jQuery z lockfile i ekstrakcją artefaktu z obrazu scratch. |
| Dokumentacja | `README.md` | Aktualne funkcje upstream wraz z lokalnymi instrukcjami diagnostyki i ograniczeniami TV. |

Konflikty tekstowe są w tych 12 plikach: dwóch workflow release, `Dockerfile`, `README.md`, `wasm/auddec.cpp`, `wasm/index.html`, `wasm/main.cpp`, `wasm/moonlight_wasm.hpp`, `wasm/platform/index.js`, `wasm/platform/messages.js`, `wasm/static/js/utils.js`, `wasm/wasmplayer.cpp`.

Automatycznie scalone `CMakeLists.txt`, `navigation.js`, CSS i scanner także wymagają przeglądu semantycznego. Pliki dodane przez upstream (audio, i18n, locale, usługa Preview) wymagają integracji i testów, mimo braku konfliktu.

## Diagnoza krótkiego czasu na PIN

Przepływ: `pairingDialog()` → `NvHTTP.pair()` → native `Pair()` → `gs_pair()` → pierwsze żądanie `phrase=getservercert` → kolejne etapy kryptograficzne → końcowe HTTPS `pairchallenge`.

1. `wasm/main.cpp:593` tworzy kontekst z `180000, 180000`.
2. `wasm/request_registry.hpp:27` niezależnie ustawia `low_speed_time_seconds=2` oraz `low_speed_bytes_per_second=1` dla każdego żądania.
3. `libgamestream/http.c:107` i kolejne linie przekazują zarówno ogólny timeout, jak i limit niskiej prędkości do libcurl.
4. `libgamestream/pairing.c:315` wysyła `getservercert`, korzystając z tego kontekstu. Brak odpowiedzi podczas wpisywania PIN-u może uruchomić limit około dwóch sekund.
5. `wasm/static/js/utils.js:651` ustawia również 180 sekund na końcowy challenge, ale jego `OpenUrl()` korzysta z tego samego domyślnego limitu low-speed.

W [oryginalnym http.c](https://github.com/brightcraft/moonlight-tizen/blob/fecbc67b1e1175e893f090a4bc9e7c269adb921e/libgamestream/http.c#L101) ustawiony jest timeout zestawiania połączenia 3 s, bez ogólnego timeoutu transferu i bez limitu low-speed. Dokumentacja libcurl: [LOW_SPEED_TIME](https://curl.se/libcurl/c/CURLOPT_LOW_SPEED_TIME.html), [TIMEOUT_MS](https://curl.se/libcurl/c/CURLOPT_TIMEOUT_MS.html).

### Dowód i granice diagnozy

Lokalny serwer HTTP na loopback opóźniał pierwszą odpowiedź o 5 s. Dwa równoległe wywołania systemowego `curl.exe` miały `--connect-timeout 3 --max-time 180`:

| Ustawienie dodatkowe | Wynik |
| --- | --- |
| `--speed-time 2 --speed-limit 1` | exit 28 po 2.008685 s: `Operation too slow` |
| Brak limitu low-speed | exit 0, odpowiedź `OK` po 5.002652 s |

To potwierdza mechanizm przedwczesnego przerwania na komputerze. Nie jest testem zbudowanego klienta WASM, Sunshine/Vibepollo ani fizycznego TV. Nie analizowano nowego logu nieudanego parowania z TV, dlatego powiązanie z konkretną próbą użytkownika pozostaje mocno uzasadnioną diagnozą, a nie odtworzeniem na urządzeniu.

Obecne `rtk npm run test:js` przechodzi: 14/14 skryptów. Test parowania mockuje natywną część i sprawdza `180000` tylko w końcowym challenge. Test ownership sprawdza tekst wywołania w C++. Żaden nie sprawdza realnego oczekiwania na odpowiedź ani low-speed; zielony wynik nie wyklucza tego błędu.

### Zalecane zachowanie parowania

- Połączenie TCP/TLS: nadal ograniczony czas zestawienia, zgodnie z upstream 3 s.
- Żądania parowania: bez lokalnego ogólnego limitu oczekiwania i bez limitu low-speed (`total=0`, `low_speed_time=0`, `low_speed_limit=0`).
- Użytkownik może anulować z pilota; anulowanie trafia do konkretnego native request ID i zwalnia operację. Spóźniona odpowiedź starej próby nie może zmienić UI ani nowej próby.
- Zwykły polling, listy aplikacji, okładki, launch/resume i cleanup/unpair zachowują swoje ograniczone timeouty.
- Serwer nadal może odmówić lub zakończyć parowanie z własnych powodów; klient nie usunie timeoutów hosta.

Alternatywa to zachowanie 180 s po wyłączeniu low-speed. Usunęłaby krótki limit, ale nadal narzucałaby lokalny czas na PIN. Rekomendowane jest przywrócenie oryginalnego oczekiwania wraz z zachowaniem lokalnego, izolowanego anulowania.

## Strategia scalenia

Rekomendacja: udokumentowany commit łączący historię na nowej gałęzi, z niezmienionym drzewem lokalnym i drugim rodzicem wskazującym upstream v1.13.1, następnie zwykły merge przypiętego v1.16.0. To jawne zapisanie pochodzenia importowanego snapshotu, a nie twierdzenie, że lokalne repo posiadało już tę historię. Nie przepisywać istniejących commitów. Przed takim krokiem ponownie potwierdzić różnice snapshotu względem v1.13.1.

Korzyść: zachowanie wszystkich lokalnych commitów, zmian ze snapshotu i historii upstream oraz sensowna baza następnych aktualizacji. Zwykły merge niepowiązanych historii bez odtworzenia bazy powodowałby liczne pozorne konflikty dodanie/dodanie.

Alternatywa: nałożyć pełny diff v1.13.1 → v1.16.0 jako patch na lokalne HEAD. Zachowuje zawartość, lecz nie połączy historii upstream, utrudniając kolejne aktualizacje. Samo przenoszenie 45 późniejszych lokalnych commitów na upstream jest niewystarczające, ponieważ pomija poprawki z początkowego snapshotu.

## Plan wykonania po zgodzie

### Zadanie 1: zabezpieczyć bazę i połączyć historię

- [ ] Ponownie odczytać HEAD, status, remote oraz SHA tagów; przy zmianie upstream względem tego dokumentu najpierw uzupełnić porównanie.
- [ ] Zachować kopię istniejącego nieśledzonego jQuery oraz aktualnego WGT wraz z hashami. Nie wykonywać `git clean`, resetu czy automatycznego stashowania cudzych plików.
- [ ] Utworzyć gałąź bezpieczeństwa dla `31666b2` i osobny worktree gałęzi integracyjnej. Dodać upstream/fetch dopiero na etapie wdrożenia.
- [ ] Powtórzyć porównanie wszystkich 37 różnic snapshotu; przygotować listę zachowywanych lokalnych zachowań, w tym RTP/RFI, timing i logi istniejące przed pierwszym commitem.
- [ ] Utworzyć opisany commit łączący historie; `git diff bridge^1 bridge` musi być pusty, a `git merge-base bridge upstream/v1.16.0` wskazywać v1.13.1.
- [ ] Rozpocząć merge v1.16.0 bez automatycznego commitowania wyniku. Rozwiązać obszary z zadań 2–4 jako jeden spójny wynik integracji.

### Zadanie 2: zintegrować UI, hosty i Preview

**Pliki:** `wasm/index.html`, `wasm/platform/{index,messages,navigation,remote_controller,i18n}.js`, `wasm/static/js/{utils,i18n-sync}.js`, `wasm/static/js/mdns-browser/main.js`, CSS, locale, `res/config.xml`, `res/service/service.js`.

- [ ] Połączyć nowe elementy UI/tłumaczenia z lokalnym dialogiem logów i RFI, zachowując identyfikatory używane przez nawigację i testy.
- [ ] Zachować inicjalizację certyfikatów, serializację hostów i generacje operacji; przenieść naprawy adresów i fallback lokalnego IP.
- [ ] Dostosować każde nowe wywołanie `openUrl` do istniejącego interfejsu z timeoutem. Pobieranie okładek nie może pominąć tego argumentu, jak pozwala upstream.
- [ ] Zachować zapisane wartości `false`, `0` i wybory list. Nowe wartości domyślne mają uzupełniać tylko nieistniejące ustawienia.
- [ ] Zintegrować Preview/deep link oraz sprawdzanie dostępności API; na niewspieranym TV zakończyć usługę bez blokowania normalnego startu aplikacji.
- [ ] Sprawdzić zmianę nazw cache okładek (`boxart-ID` → `boxart-ID.png`); nie usuwać przy aktualizacji istniejących danych użytkownika. Cache może zostać ponownie pobrany.
- [ ] Rozszerzyć `tests/ui_reliability_behavior_tests.js`, `tests/subnet_scanner_tests.js` i `tests/http_bridge_tests.js`: zmiana IP aktualizuje oba base URL, usunięty host nie wraca przez callback, odrzucone pobranie okładki kończy promise, stare ustawienia/certyfikaty przetrwają odtworzenie, nowe listy i przełączniki przetrwają restart/reset.
- [ ] Dodać `tests/upstream_ui_integration_tests.js` dla i18n, braku Preview API i inicjalizacji nowych ustawień. Zarejestrować test w package.json i oczekiwanym manifeście testów.

### Zadanie 3: połączyć audio z poprawkami Tizen 9

**Pliki:** `wasm/main.cpp`, `wasm/moonlight_wasm.hpp`, `wasm/auddec.cpp`, `wasm/wasmplayer.cpp`, `wasm/platform/audio.js`, `wasm/platform/messages.js`, `wasm/platform/index.js`.

- [ ] Uzgodnić kolejność argumentów startu w JS, wrapperze embind, deklaracji i implementacji C++; dodać backend/jitter, zachować RFI.
- [ ] Zintegrować backend Web Audio z upstream bez zastępowania lokalnej implementacji EMSS i diagnostyki.
- [ ] W EMSS zachować oczekiwanie na audio i video track open oraz lokalne epoki/timeouty; w Web Audio oczekiwać wyłącznie wymaganych torów EMSS, czyli wideo.
- [ ] Zachować monotoniczne PTS, anulowalny frame pacing, korekty audio sync, ownership i bezpieczny teardown. W logach sesji zapisywać wybrany backend i jitter, aby odróżniać wyniki A/B.
- [ ] Dodać `tests/audio_backend_behavior_tests.js`: EMSS jako domyślne, Web Audio z właściwym jitter, stop opróżnia scheduler, callback poprzedniej sesji nie odtwarza audio w nowej sesji.
- [ ] Rozszerzyć testy media ownership/operation epoch i połączenia: Web Audio startuje bez zdarzenia audio-track-open; EMSS nadal go wymaga; opóźniony `Play()` nie blokuje gotowych torów na Tizen 9; anulowanie przerywa oczekiwanie.
- [ ] Uruchomić natywne testy audio sync, audio pipeline/transport diagnostics, video timing/receive diagnostics, RFI, media epoch/track diagnostics, operation latch, owned pthread, dispatcher i connection lifecycle.

### Zadanie 4: zachować build i warianty upstream

**Pliki:** `Dockerfile`, `CMakeLists.txt`, `.github/workflows/{release-development,release-stable,release-usb}.yml`, `package.json`, `package-lock.json`, `README.md` oraz nowe/pliki konfiguracyjne `.github` ze zmian upstream.

- [ ] Zachować lokalny lockfile jQuery 2.2.0 i wytwarzanie zależności frontendowych, dodać wydzielony cache SDK z upstream.
- [ ] Zainstalować usługę Preview, audio.js, i18n.js i locale w WGT; zachować diagnostykę i operation_guard.
- [ ] Połączyć wariant ForceGM z lokalnym obrazem scratch: kopiowanie artefaktów musi obsłużyć właściwą nazwę WGT, a workflow ma używać `docker create`/`docker cp`, nie próbować uruchamiać scratch.
- [ ] Standard pozostaje wariantem przeznaczonym do pierwszego testu na TV; ForceGM jest opcjonalnym wariantem builda, nie zmianą domyślnego zachowania.
- [ ] Uaktualnić wersję 1.16.0 w spójnych manifestach przy zachowaniu identyfikatorów aplikacji i pakietu. Przejrzeć pozostałe pliki .github/upstream, aby żaden element różnicy 32 plików nie został pominięty.
- [ ] Zaktualizować test manifestu zależności do końcowego układu pakowania i nowych testów, bez osłabiania kontroli profilu legacy.
- [ ] Przejrzeć pełny staged diff, uruchomić dostosowane testy JS/native oraz build przed zakończeniem commitu integracyjnego.

### Zadanie 5: przywrócić oczekiwanie na PIN jako osobną poprawkę

**Pliki:** `wasm/request_registry.hpp`, `wasm/main.cpp`, `wasm/http.cpp`, `wasm/static/js/utils.js`, `libgamestream/http_context.{c,h}` jeśli potrzebna wspólna polityka; testy request registry, http context, pairing ownership i pairing timeout.

- [ ] Najpierw dodać regresję rzeczywistej polityki: kontekst parowania ma `connect=3000`, `total=0`, `low_speed_time=0`, `low_speed_limit=0`. Zwykły HTTP nadal ma skończony total i low-speed 2 s / 1 B/s. Uruchomić i potwierdzić FAIL na obecnej polityce.
- [ ] Rozszerzyć registry o jawne parametry low-speed z dotychczasowymi wartościami domyślnymi. Proponowany interfejs zachowuje dotychczasowe wywołania:

```cpp
Create(callback_id, connect_timeout_ms, total_timeout_ms,
       low_speed_time_seconds = 2, low_speed_bytes_per_second = 1);
// Wywołanie dla parowania:
Create(callbackId, 3000, 0, 0, 0);
```

- [ ] Zastosować politykę do natywnego Pair i końcowego HTTPS pairchallenge. Jeżeli wykorzystany zostanie istniejący argument `timeoutMs=0` mostu OpenUrl, jawnie powiązać tę wartość z wyłączeniem low-speed i sprawdzić wszystkie miejsca użycia; nie uznawać samego `total=0` za wystarczającą naprawę.
- [ ] Zachować osobny krótki kontekst `gs_unpair` przy sprzątaniu oraz cancel callback libcurl. Nie cofać walidacji hex, limitów bufora ani ownership certyfikatów.
- [ ] Zamienić testy wymuszające `180000` na kontrolę nowego kontraktu. Dodać test native HTTP z lokalnym serwerem opóźniającym odpowiedź o 5–10 s, używający rzeczywistego kontekstu i `http_request`, nie wyłącznie mocka JS.
- [ ] Dodać przypadki anulowania podczas oczekiwania, ponowienia próby, odłączenia hosta, błędnego PIN-u i późnego callbacku. Oczekiwać zwolnienia registry i braku wpływu starej próby na nową.
- [ ] Test braku limitu 180 s oprzeć na sprawdzeniu opcji kontekstu; długie rzeczywiste oczekiwanie ponad 180 s włączyć do testu TV, bez spowalniania każdej regresji automatycznej.
- [ ] Wykonać testy i zapisać poprawkę parowania jako osobny commit po integracji upstream, aby łatwo było ją ocenić i cofnąć niezależnie.

### Zadanie 6: walidacja końcowa i artefakt

- [ ] `rtk npm run test:js` musi przejść razem z nowymi testami. `tests/dependency_manifest_tests.js` musi potwierdzać pełną rejestrację.
- [ ] Uruchomić wszystkie lokalne natywne zestawy C/C++ z aktualnym katalogiem worktree; stosować `-Wall -Wextra -Werror` i ASan/UBSan tam, gdzie wspierane. Nie kopiować starych ścieżek `/mnt/c/Users/madej/Downloads/...` z wcześniejszych planów.
- [ ] Uruchomić `rtk powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/receiver_integration_test.ps1`.
- [ ] Sprawdzić Docker, zbudować standardowy WGT i wariant ForceGM, sprawdzić zawartość, wersję, required_version=5.5, zasoby nowych funkcji, podpis i SHA-256 obu artefaktów. Sprawdzić zgodność tożsamości podpisu z dotychczasową instalacją przed ewentualną aktualizacją TV; nie rozwiązywać problemu instalacji przez automatyczne odinstalowanie aplikacji.
- [ ] Porównać wynik z listą wszystkich lokalnych zachowań i zmian upstream. Nie ograniczać przeglądu do plików, w których Git zgłosił konflikt.
- [ ] Przygotować raport: co zintegrowano, jakie testy wykonano, hash WGT, znane ograniczenia i wynik testów urządzenia, jeśli faktycznie się odbyły.

## Kryteria akceptacji na TV

| Scenariusz | Oczekiwany wynik |
| --- | --- |
| Nowy host Sunshine i osobno Vibepollo; PIN po 10, 60 i ponad 180 s | Klient nie przerywa sam oczekiwania; poprawny PIN kończy parowanie, jeśli host nadal obsługuje próbę. |
| Anulowanie z pilota, natychmiastowa ponowna próba | Dialog i native request kończą się poprawnie; kolejna próba działa; stary callback nie zmienia UI. |
| Host offline lub błędny PIN | Czytelny błąd; połączenie/ponowienie pozostają możliwe. |
| Aktualizacja aplikacji | Zachowane hosty, client ID, certyfikaty, logi i zapisane ustawienia; istniejący host nie wymaga ponownego parowania. |
| EMSS na dotychczasowej konfiguracji TV | Start obrazu/dźwięku, stop i ponowne połączenie działają; zachowane korekty PTS/audio i diagnostyka. |
| Web Audio | Dźwięk działa bez toru audio EMSS; jitter zmienia się według ustawienia; stop/reconnect nie odtwarzają starych buforów. |
| Kodeki/HDR/RFI | H.264 i używane HEVC/AV1/HDR sprawdzone na wspieranym sprzęcie; RFI domyślnie off, zapisany wybór pozostaje. |
| Nowy interfejs | Pilot/gamepad obsługują nowe listy i istniejące logi; ustawienia trwają po restarcie; brak Preview API nie blokuje Tizen 9. |
| Dłuższa sesja | Porównanie z poprzednim WGT przy tym samym hoście, sieci, kodeku, FPS/bitrate; bez nowej regresji freeze/audio. |

## Co wykonano w tej analizie

- Porównanie historii i zawartości lokalnego repo z przypiętym upstream.
- Symulacja scalenia w odrębnej kopii bare: 12 plików konfliktowych.
- Prześledzenie ścieżki timeoutu i demonstracja libcurl na lokalnym HTTP.
- Wykonanie istniejących 14 skryptów testów JS: wszystkie PASS.
- Przygotowanie tego dokumentu. Nie wykonano implementacji, commitu, zmiany gałęzi, budowania WGT, instalacji ani testu TV.
