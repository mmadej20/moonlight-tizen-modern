# Dochodzenie: sporadyczne zawieszenie aplikacji (2026-10-18)

Objaw zgłoszony przez użytkownika: aplikacja czasem się zawiesza i trzeba ją zrestartować, żeby wrócić do streamu.
Zwykle zdarza się raz na początku, potem działa bez problemu, czasem zawiesza się drugi raz.

Status: **przyczyna nie została udowodniona.** Poniżej tylko to, co wynika z logów i z kodu, z oceną pewności.

## 1. Co pokazują dostępne logi (`tools/moonlight-tv-logs`)

- Najnowszy log pochodzi z 2026-08-02, czyli sprzed wszystkich scaleń z upstream. Nie ma logu z opisanego zawieszenia.
- Wszystkie 7 zarejestrowanych sesji wystartowało poprawnie: od `Initializing platform` do `Started` mija 1,0-2,5 s.
- Sesje z 2026-07-29 (45 min) i 2026-08-02 (95 min) kończą się tak samo: pakiety wideo na okno 10 s spadają
  (z ok. 31000 do ok. 20000), potem cisza, pakiety audio też zanikają, potem `Failed to send ENet control packet`
  i rozłączenie ENet. W logu z 2026-08-02 widać to jako `VideoTransportStall noPacketMs=1037`, potem `6037`, oraz
  serię 31 komunikatów `Control message took over 10 ms to send`. Log z 2026-07-29 powstał jeszcze bez heartbeatu
  stall, ale ostatnie okno audio ma 67 pakietów zamiast ok. 780. W obu cleanup klienta kończy się w całości
  (ok. 160 ms). To wygląda na utratę łączności TV (Wi-Fi/sieć), a nie na zawieszenie kodu.
- Sesje z 2026-07-28 (profil 9.0/jQuery 4) urywają się bez cleanupu. Tam log po prostu przestaje powstawać.
- Pierwsze okno `AudioTransportStats` bywa bardzo długie (22-40 s, 1-250 pakietów). To artefakt raportowania: okno
  zamyka się dopiero po nadejściu pakietu, a host nie wysyła audio w ciszy. Nie jest to awaria klienta.

## 2. Dlaczego logowanie nie pokazuje przyczyny

- Zapis logów robi **wyłącznie wątek główny**: `diagnostic_logs.js:177` (`setInterval(pollNative, 1000)`), potem
  `Module.drainDiagnosticLogs()` i zapis przez `tizen.filesystem`. Natywny bufor (256 KB) zbierają wątki robocze,
  ale nikt go nie opróżnia, gdy wątek główny stoi.
- Skutek: zawieszenie wątku głównego i śmierć całego procesu dają w logu ten sam obraz, czyli nagłe urwanie.
  Wniosek z 2026-07-28 „zatrzymał się cały runtime” opierał się więc na logach, które w obu wariantach musiały się urwać.
- `beginSession` (`diagnostic_logs.js:260`) kopiuje bieżący log do „previous” przy każdym nowym streamie. Log
  zawieszonej sesji trzeba wyeksportować zaraz po restarcie aplikacji, przed kolejnym startem streamu.

## 3. Znaleziska w kodzie (od najlepiej pasującego do objawu)

### A. Jedna kolejka HTTP dla wszystkiego, w tym dla okładek (pewność mechanizmu: wysoka; że to Twoja przyczyna: nieznana)

- `wasm/dispatcher/lib.hpp:82`: `Dispatcher` ma jeden wątek (`std::thread thread_`). Przez niego idą wszystkie
  `OpenUrl`, `Pair`, `STUN`, `WakeOnLan` (`http.cpp:192`, `main.cpp:608/643/657`), w kolejności FIFO.
- `index.js:2641-2648`: po wczytaniu listy aplikacji każda aplikacja bez okładki w cache zleca osobne pobranie
  (`utils.js:589`, limit 10 s). Brak limitu współbieżności i brak anulowania. Komentarz autorów w tym miejscu
  sam opisuje skutek: `/serverinfo` stoi „behind 40+ concurrent image downloads”.
- `index.js:2970`: `startGame` zaczyna od `host.refreshServerInfo()`, a spinner (`showStreamMode`, `index.js:3080`)
  pojawia się dopiero po jego zakończeniu. Potem `resumeApp/launchApp` (`utils.js:892/901`) też idą przez tę kolejkę.
- W tym forku limit czasu żądania liczy się od jego rozpoczęcia, więc żądanie w kolejce nie wygasa, tylko czeka.
- Pasuje do wzorca „raz na początku, potem dobrze”: okładki zapisują się na dysk (`utils.js:599`), więc zimny cache
  występuje tylko po instalacji, nowym hoście lub dodaniu aplikacji, a każdy restart przynosi postęp w cache.
- Czego nie wiemy: ile żądań stoi w kolejce na TV i jak długo trwa. Nie ma logu czasu oczekiwania w kolejce.

### B. Ścieżki, które zostawiają stan „zablokowany do restartu” (pewność: wysoka, prawdopodobieństwo wystąpienia: niskie)

- `main.cpp:134-141` i `156-163`: `StopThreadFunc` wychodzi wcześnie przy błędzie `Join`, bez `onConnectionStopped` i bez
  `MarkIdle()`. JS nigdy nie dostaje `streamTerminated`, a `ConnectionLifecycle` zostaje w `Stopping`.
- `main.cpp:354-360`: przy błędzie `m_StopThread.Join()` wywoływane jest `BeginStop()` bez żadnego wątku zatrzymania,
  więc stan zostaje w `Stopping`.
- W obu przypadkach każdy kolejny `StartStream` zwraca `GS_WRONG_STATE`, aż do restartu aplikacji.

### C. Blokada statystyk trzymana podczas `AppendPacket` (pewność: wysoka, wpływ: niski)

- `wasmplayer.cpp:654-791`: `s_VideoStatsMutex` jest trzymany przez cały `AppendPacket` (linia 727).
- `TogglePerformanceStats` (`wasmplayer.cpp:994`) bierze tę blokadę na wątku głównym. Przy wolnym `AppendPacket`
  przełączenie overlayu zablokuje wątek główny.

### D. Ryzyka środowiskowe (niezweryfikowane)

- `CMakeLists.txt:269-283`: sztywna pamięć 128 MB (brak `ALLOW_MEMORY_GROWTH`), stos 16 MB, pula 20 wątków,
  `-DNDEBUG`, `-w`. Wyczerpanie pamięci lub wątków skończyłoby się cichym błędem, bez śladu w logu.
- `PostToJs` i `PostPromiseMessage` (`main.cpp:840-868`) są synchronicznymi wywołaniami wątku głównego (`MAIN_THREAD_EM_ASM`).
  Wątek roboczy, który je wywoła, stoi, dopóki wątek główny nie wykona JS. Nie znaleziono cyklu oczekiwania, ale
  każde zablokowanie wątku głównego zatrzymuje też wątki, które z niego korzystają.

### Sprawdzone i bez zarzutu

`OwnedPthread`, `OperationLatch`, `MediaOperationEpoch`, `DiagnosticLogBuffer::TryAppend` (try_lock), powiadamianie JS po
stronie `streamTerminated`, ścieżka błędu `showApps` (zawsze wywołuje `showAppsMode`, poza odrzuceniem dla `!host.paired`).

## 4. Co rozstrzygnęłoby przyczynę

1. Log zawieszonej sesji wyeksportowany zaraz po restarcie (Current session, przed kolejnym streamem).
2. Pomiar czasu oczekiwania żądań HTTP w kolejce (natywny log: czas od zlecenia do startu, dla żądań dłuższych niż 1 s).
3. Znacznik żywotności wątku głównego zapisywany co sekundę osobno od logów (np. do `localStorage`) oraz znacznik
   „nieczysty koniec poprzedniej sesji” przy starcie. Odróżni zawieszenie wątku głównego od śmierci procesu.
4. Natywny licznik żywotności wątków wideo i audio (log tylko przy anomalii), by odróżnić zatrzymanie renderera od
   zatrzymania transportu.

## 5. Odpowiedzi użytkownika i zmiana oceny

Odpowiedzi użytkownika po pierwszej wersji tej analizy:

- Co widać: zamrożony obraz, po chwili urwany dźwięk, brak reakcji na kontroler i brak możliwości powrotu do menu.
  Aplikację trzeba zamknąć przytrzymaniem Back na pilocie TV.
- Kiedy: po pierwszych minutach streamu.
- Jak często: prawie zawsze przy pierwszym streamie danego dnia, potem działa bez problemu.
- Sieć i profil: Wi-Fi, profil 5.5.

Co z tego wynika:

- To **nie jest zawieszenie na starcie**, więc kolejka okładek (punkt 3A) może być tylko czynnikiem pobocznym.
- Obraz zamarza od razu, a dźwięk urywa się dopiero po chwili, bo bufor audio w TV się opróżnia. To sygnatura
  **jednoczesnego zatrzymania wszystkiego, co dotyka wątku głównego lub potoku mediów**, a nie samej sieci.
- Utrata sieci kończy się w logach rozłączeniem ENet po ok. 8 s i powrotem do listy aplikacji. Tutaj nic takiego nie
  następuje, a lokalne wyjścia ze streamu (czerwony przycisk pilota i kombinacja na padzie) też nie działają.
  To wskazuje na zamrożony wątek główny albo cały proces, a nie na zerwane Wi-Fi.
- Korelacja z pierwszym streamem dnia: TV po rozruchu wykonuje w tle własne zadania (pamięć, CPU, Wi-Fi), a
  aplikacja raz na dobę sprawdza aktualizacje (`checkForAppUpdatesAtStartup`). Nie ma dowodu, że któreś z nich jest
  przyczyną. Dlatego zamiast kolejnych hipotez dodano narzędzia, które to rozstrzygną.

## 6. Co wdrożono (2026-10-18)

1. **Strażnik strumienia**: tętno zapisywane co sekundę, raport „poprzednie uruchomienie skończyło się podczas
   streamu" przy kolejnym starcie, wykrywanie przestojów wątku głównego.
2. **Zdrowie streamu** po stronie natywnej: liczniki pakietów wideo i audio, czas wywołań `AppendPacket`, czas rundy
   wątku wejścia (sonda responsywności wątku głównego), czas oczekiwania wątków roboczych na wątek główny, rozmiar sterty.
3. **Log kolejki HTTP**: żądania czekające w kolejce co najmniej 1 s lub trwające co najmniej 3 s (tylko ścieżka URL).
4. **Okładki**: najwyżej 2 pobierania naraz, porzucanie przestarzałych, anulowanie przy wejściu do streamu, natychmiastowa
   informacja „Starting …" po wciśnięciu aplikacji.
5. **Odporność cyklu życia**: zatrzymanie zawsze powiadamia interfejs i wraca do stanu bezczynności; nieudany start oddaje
   miejsce przez `AbortStart`.

Jak odczytać wynik po następnym zawieszeniu: sekcja „Diagnosing a freeze" w `docs/diagnostic-logs.md`.

## 7. Pozostałe hipotezy do rozstrzygnięcia po zebraniu danych

- Zablokowane wywołanie platformowego `AppendPacket` (potok mediów Samsunga): pokaże to `videoAppendBlockedMs`.
- Zablokowany lub zagłodzony wątek główny (pytania o gamepad są synchronicznie przekazywane do wątku głównego ok. 200
  razy na sekundę): pokaże to `inputPollMaxMs` i `inputPollBlockedMs`.
- Wyczerpanie sztywnej sterty 128 MB: pokaże to `heap`.
- Zabicie lub zamrożenie całej aplikacji przez TV: wszystkie liczniki zatrzymają się razem z tętnem.
- Jeśli wątek główny okaże się winny, kolejny krok to wyprowadzenie z wątków roboczych synchronicznych wywołań
  `PostToJs` i zapytań o gamepad.

## 8. Pytania (pierwotne, już odpowiedziane powyżej)

- Co dokładnie widać: zamrożony obraz z działającym dźwiękiem, czarny ekran ze spinnerem, nieruchoma lista aplikacji, brak reakcji pilota?
- Kiedy: zaraz po wciśnięciu aplikacji, w pierwszych minutach streamu, czy po wielu minutach?
- Czy dzieje się po świeżej instalacji lub po dodaniu aplikacji na hoście? Ile aplikacji ma host?
- Wi-Fi czy Ethernet, jaki model TV, który WGT jest zainstalowany (profil 5.5 czy 9.0)?

## 9. Regresja: start streamu wisi na „Starting …", okładki ładują się bardzo długo

Po wdrożeniu punktu 2 (build `freeze-diag`) aplikacja przestała uruchamiać streamy: Vibepollo dostawał `/launch`
i startował grę, a Moonlight zostawał na „Starting …". Okładki ładowały się znacznie wolniej niż wcześniej.

**Przyczyna (potwierdzona odtworzeniem):** `BlockingSection::End` aktualizowało maksimum pętlą
`compare_exchange_weak` na `std::atomic<int64_t>`. Samsungowy Emscripten (fastcomp 1.39.4.7) sprowadza 64-bitowe
atomiki do wywołań biblioteki, a wywołanie `___atomic_compare_exchange_8` ma tam błędną sygnaturę (ostrzeżenie
`asm2wasm adding operands in call … ___atomic_compare_exchange_8`, ukryte przez `-w` w buildzie). Pętla nigdy się
nie kończyła, więc wątek, który wszedł do sekcji, kręcił się w niej na zawsze. Dotyczyło to każdego wątku, który zmierzył
wywołanie dłuższe niż dotychczasowe maksimum: wątek połączenia przy pierwszym komunikacie „Starting connection to …"
(14 ms, bo wątek główny kończył jeszcze `StartStream`) oraz wątek HTTP przy odpowiedzi na żądanie, gdy wątek główny był
zajęty. Zablokowany wątek HTTP tłumaczy też wolne okładki.

**Ślad w logu:** `mainCalls=1`, `mainCallMaxMs=14` (to samo w każdym zrzucie, bo wątek w pętli stale ustawiał maksimum
na nowo po jego wyzerowaniu przez zrzut) i rosnące `mainCallBlockedMs`, a po ostatnim komunikacie startu brak
jakiejkolwiek linii natywnej (`RTSP port: …` nie pojawiło się), bo `LiStartConnection` nigdy nie został wywołany.

**Odtworzenie:** krótki program z tym samym toolchainem i flagami (`-pthread -Os -flto`), wątek roboczy wchodzący w
`ScopedSection` wokół `MAIN_THREAD_EM_ASM` trwającego 14 ms, uruchomiony w Chromium/Edge z nagłówkami COOP/COEP
(wątki wasm wymagają `SharedArrayBuffer`; node 12 z tego toolchainu nie obsługuje pthreadów tego Emscriptena). Stary
nagłówek: `mainCalls=1 mainCallMaxMs=14 mainCallBlockedMs` rośnie. Nowy nagłówek: 200 z 200 wywołań z dwóch wątków,
czasy 0–28 ms, kończy się bez blokady.

**Naprawa:** `stream_health.hpp` używa wyłącznie 32-bitowych atomików; czasy to dolne 32 bity zegara ms, odejmowane z
zawijaniem (poprawne dla przedziałów krótszych niż 24 dni). `tests/wasm_atomics_guard_tests.js` pilnuje, żeby w
`wasm/` nie pojawił się 64-bitowy `std::atomic` (wyjątek: `diagnostic_log.hpp`, tylko `fetch_add`/`exchange`) ani
`compare_exchange` na takim atomiku.

**Wniosek metodyczny:** błąd w kodzie diagnostycznym wyglądał jak zawieszenie mechanizmu proxy Emscriptena
(wątek roboczy w synchronicznym wywołaniu do wątku głównego). Rozstrzygnęło go dopiero odtworzenie w przeglądarce, a nie
analiza kodu źródłowego tego mechanizmu.

## 10. Zawieszenia po stronie sterty: forensyka na TV i test obciążeniowy (2026-10-19/20)

Zawieszenia długiego streamu nie zniknęły po naprawie z sekcji 9. Build `opt2b-O2` (ten sam wasm co `opt2-O2`) złapał
na TV trzy różne sygnatury. Narzędzia, którymi je złapano, są w `tools/tv-debug/` (opis w README tego katalogu):
watcher przez Chrome DevTools Protocol, walker łańcucha chunków dlmalloc wstrzykiwany do strony oraz kanał komend do
badania zamrożonego procesu.

**Złapane sygnatury.**

1. *19.10 14:07 UTC, 63 s po starcie streamu.* Wątek kontrolny ENet wywrócił się na `memory access out of bounds` w
   `free` (`enet_packet_destroy` ← `enet_protocol_remove_sent_reliable_command` ← `enet_host_service`). Wątek zginął z
   zajętą blokadą alokatora, reszta czekała w `_emscripten_futex_wait`.
2. *19.10 19:40 UTC, po 27 min.* Wątek odbioru wideo (`VideoReceiveThreadProc` → `RtpvAddPacket` → `queueRtpPacket` →
   `malloc`) wywrócił się w `malloc` 30 ms po „Sending RFI request for unrecoverable frame" i „VideoRecovery IDR frame
   assembled". Równocześnie wątek kontrolny ENet stał w `free` z tej samej ścieżki co w punkcie 1.
3. *19.10 20:20 UTC, po 23 min.* **Zawieszenie bez trapu.** Szczegóły niżej.

**Zawieszenie 3.**

- Blokada alokatora (zwykły `pthread_mutex`, ścieżka `malloc` → `__pthread_mutex_lock` → `__timedwait_cp` →
  `_emscripten_futex_wait`) miała `_m_lock = 0x8000000A` i `_m_waiters = 7`. W libc tego toolchainu `EBUSY` to
  `__WASI_ERRNO_BUSY` = 10, więc to zwyczajny stan „zajęty, są czekający"; szybka ścieżka nie zapisuje właściciela.
- Na tym samym adresie futeksa, z oczekiwaną wartością równą bieżącej, czekało sześć wątków: główny (w
  `getStreamHealth`), odbiór wideo, wysyłka wejścia ENet, wątek kontrolny (`free`), wątek wejścia kontrolera i wątek
  statystyk strat. Pozostałe wątki stały na zwykłych kolejkach i zdarzeniach, wątek odbioru audio pracował. Żaden nie
  był w alokatorze, czyli **nikt nie trzymał blokady**.
- Wszystkie 20 workerów jest rozliczone: 13 w użyciu, 7 bezczynnych. Bezczynny worker nie odpowiada na ewaluację,
  dopóki nie wykona JS, bo czeka na niego zakolejkowane `Debugger.pause`; timeout nie oznacza więc śmierci. Nie było
  zdarzeń `detached` ani wyjątków w konsolach workerów.
- Wyzerowanie słowa blokady i `_emscripten_futex_wake(adres, INT_MAX)` z wstrzymanego workera obudziło sześć wątków.
  Wątek główny ruszył od razu, workery oddały zaległe logi, aplikacja zgłosiła `streamTerminated: -1` (host zerwał
  sesję po minutach ciszy) i wróciła do listy gier. Całe zawieszenie to ta jedna zablokowana blokada.
- Łańcuch chunków: 4012 chunków z poprawnymi rozmiarami i jedna anomalia. Wolny chunk 456 B (w drzewie, ze stopką 456,
  z resztkami tekstu heartbeatu `getStreamHealth` w treści) ma następnika z ustawionym bitem `PINUSE`, którego `free`
  nie zostawia. Kontrole co 15 s były czyste do ok. 20:20:37, więc anomalia powstała w ostatnich sekundach przed
  zawieszeniem.

**Test obciążeniowy.** `wasm/alloc_stress.hpp` (logika, testowana na hoście w `tests/alloc_stress_tests.cpp`, razem z
dowodem, że wykrywa wstrzyknięty wyścig licznika i uszkodzony blok) i `wasm/alloc_stress.cpp` (eksport do JS). Wchodzi
do modułu tylko z `docker build --build-arg ALLOC_STRESS=ON`. Robi na wielu wątkach: `std::mutex` wokół niepodzielnego
odczytu i zapisu, licznik 32-bitowy atomowy, spin-lock na `exchange`, oraz `malloc`/`realloc`/`free` bloków w
rozmiarach z mieszanki streamu, wypełnionych wzorcem i sprawdzanych przed zwolnieniem; co czwarty blok zwalnia inny
wątek niż ten, który go zaalokował.

| Przebieg | Wynik |
|---|---|
| 12 wątków bez pauz | Po 28 s czysto, po 43 s aplikacja zniknęła. Cały TV zaczął się zacinać i trzeba go było zrestartować. Za ciężki, nic z niego nie wynika. Stąd pauzy w wątkach i automatyczne przerwanie, gdy główny wątek odpowiada wolniej niż 2,5 s. |
| 3 wątki, 120 s | 3,46 mln iteracji, 0 błędów, liczniki zgodne, łańcuch sterty spójny. |
| 4 wątki, 20 min | 79 mln iteracji (79 mln `malloc`, 79 mln `free`, 2,5 mln `realloc`), 19,7 mln zwolnień przez inny wątek, 0 błędów wzorców, liczniki mutexa, atomika i spin-locka zgodne co do jednej jednostki, najdłuższy bezruch wątku kilka ms, łańcuch sterty spójny. |

**Wnioski.**

- Mutex, 32-bitowe atomiki i `malloc`/`free` działają poprawnie pod dużym obciążeniem samych wątków roboczych (ok.
  160 mln operacji alokatora, w tym samym rzędzie co ekspozycja streamu do awarii). Sam toolchain lub platforma psująca
  blokadę jest przez to mało prawdopodobna.
- Test **nie obejmował** wątku głównego, na którym `futex_wait` to pętla obsługująca kolejkę wywołań proxy, a nie
  `Atomics.wait`, ani kodu aplikacji piszącego do pamięci.
- Sygnatura 3 (anomalia powstała tuż przy zawieszeniu, blokada bez właściciela) pasuje do wątku zatrzymanego w środku
  operacji alokatora. Którego i dlaczego, nie ustalono.

**Otwarte hipotezy i dalsze kroki.**

1. ~~Przepełnienie stosu wątku~~ **wykluczone analizą statyczną** (`tools/tv-debug/stack_frames.js`, bez TV i bez
   streamu). Stosy wątków to bloki po 2 MB z `malloc`, a stos rośnie w górę (wskaźnik stosu startuje poniżej
   `STACK_MAX`), więc przepełnienie uderzyłoby w nagłówek następnego chunka. Ale największa ramka w module (`-O2`) to
   `reed_solomon_reconstruct` 70 KB, najcięższy łańcuch bezpośrednich wywołań (wątki odbioru wideo i audio) to ok.
   75 KB, wśród wywołań bezpośrednich nie ma rekursji, a 35 funkcji z alokacją dynamiczną na stosie to dekodowanie Opus,
   `invert_mat` z FEC i kilka drobnych. Zapas względem 2 MB to ponad 25 razy. Nie śledzono wywołań przez wskaźniki do
   funkcji, ale żadna ramka spoza 30 największych (w tym żaden callback strumienia) nie przekracza 2,3 KB.
2. Wątek główny w grze o blokadę razem z emulacją futeksa i kolejką proxy: test obciążeniowy z wywołaniami proxy i
   `malloc`/`free` wołanymi z JS na wątku głównym, w trakcie obciążenia wątków roboczych.
3. ~~Zapisy z JS do pamięci modułu~~ **przejrzane, czyste.** W kodzie projektu (`wasm/`, `wasm/platform/`) jedynym
   zapisem z JS do pamięci modułu jest `__fillGamepadEventData` w `gamepad_sampling.hpp`: najwyżej 16 slotów, krok
   `sizeof(EmscriptenGamepadEvent)`, tablica 16 elementów w `gamepad.cpp`. Pozostałe miejsca (`audio.js`, `PostPromiseMessage`
   w `main.cpp`) tylko czytają. Kod Emscriptena (`library_html5.js`, `library_pthread.js` tego toolchainu) przejrzano:
   - `_fillGamepadEventData` **nie ogranicza** liczby osi i przycisków do rozmiaru struktury (pętle po
     `e.axes.length` i `e.buttons.length` zapisują `axis[i]`, `analogButton[i]` i `digitalButton[i]` bez sprawdzenia; tylko
     napisy `id` i `mapping` są ograniczone do 64 bajtów). Pad zgłaszający ponad 64 osi lub przycisków pisałby poza
     strukturę, a nasza tablica `events[16]` leży w pamięci statycznej, obok struktur alokatora. To ten sam kod co w
     upstreamie (ścieżka `emscripten_get_gamepad_status`), a zwykłe pady mają kilka osi i kilkanaście przycisków, więc
     nie ma dowodu, że to nasza przyczyna. Tani test: sprawdzić w logach `numAxes` i `numButtons` używanego pada.
   - `emscripten_futex_wait`/`wake`: emulacja czekania wątku głównego rejestruje adres przed sprawdzeniem wartości,
     przywraca poprzedni adres przy timeoucie i `EWOULDBLOCK`, a zagnieżdżone czekanie kończy się co najwyżej
     fałszywym obudzeniem. Nie znalazłem w niej scenariusza trwałej utraty obudzenia na blokadzie alokatora.
   - Zauważone przy zawieszeniu 3: `_m_waiters = 7` przy sześciu widocznych czekających, czyli jeden zgubiony
     licznik. Któryś wątek opuścił czekanie na blokadzie bez zmniejszenia licznika (np. wyjątek w środku czekania). To
     poszlaka o wcześniejszym nietypowym wyjściu wątku, ale bez śladu w logach.
4. Niezależnie od przyczyny: mniej alokacji na gorących ścieżkach (bufory pakietów wideo, pakiety ENet) wydłuża czas
   między awariami, a doraźny watchdog w wątku natywnym, który wykryje brak postępu i zwolni zablokowaną blokadę, jest
   wykonalny (ręczne zwolnienie przywróciło aplikację), choć nie wiadomo, czy sesja by to przeżyła. Wdrożony jako
   `wasm/platform/futex_guard.js` z łatką pętli futeksa wątku głównego (sekcja 11); na prawdziwym zawieszeniu jeszcze
   nie sprawdzony.

## 11. Trop z historii: profil Tizen 9 + jQuery 4 (2026-10-20)

Użytkownik przypomniał sobie, że po przejściu na „Tizen 9 only" i nowe jQuery freezy pojawiały się po rozpoczęciu
streama za każdym razem, więc wrócił do poprzedniego profilu. Historia to potwierdza i zawęża:

- `7eff49d` (`build: target Tizen 9 with modern frontend`, 25.07) zmienił w runtime tylko `required_version` z 5.5 na
  9.0 w `res/config.xml` i jQuery z 2.2.0 na 4.0.0. `CMakeLists.txt`, toolchain (Tizen Studio 6.1, Samsung Emscripten
  1.39.4.7) i wygenerowany moduł wasm pozostały bez zmian (`docs/2026-07-28-current-session-freeze-analysis.md`).
  Powrót to `ac1a228` (28.07, `build: restore legacy Tizen runtime profile`).
- Zawieszenia z 28.07 (po 380 s i po 826 s, log urwany w środku zapisu) pochodzą z profilu 9.0 + jQuery 4. Ten sam
  kod na profilu legacy przestreamował 37 minut bez crasha (`docs/2026-07-29-legacy-runtime-session-transport-
  analysis.md`), ale to jedna sesja, a freezy na profilu legacy też się zdarzają (sekcja 10).
- `b2aa50e` zauważa, że na części TV z Tizen 9 obie ścieżki EMSS się otwierają, ale callback `Play` nigdy się nie
  kończy: runtime zachowuje się tam inaczej.

Profile da się rozdzielić, bo wasm jest ten sam. Dockerfile ma do tego argumenty `REQUIRED_VERSION` (np. 9.0),
`JQUERY_VERSION` (np. 4.0.0) i `LOCK_GUARD` (domyślnie `off`: adres blokady 0, guard z sekcji 10 nieaktywny, więc zawieszenie jest widać bez
maskowania; `on` zapisuje prawdziwy adres). Zbudowano trzy warianty bieżących źródeł: `opt3-r90` (tylko 9.0), `opt3-jq4` (tylko jQuery 4) i
`opt3-r90-jq4` (oba). **Wyniki testu na TV: jeszcze brak.** Jeśli któryś zawiesza się powtarzalnie po starcie
streama, jest reproduktorem, na którym watcher z `tools/tv-debug/` pokaże, czy to ta sama zablokowana blokada
alokatora, i na którym da się sprawdzić guard.

## 12. Zawieszenie na buildzie 9.0 + jQuery 4 i uszkodzony bufor pakietu wideo (2026-10-20)

Wynik testu z sekcji 11 (`opt3-r90-jq4`, guard wyłączony, watcher z `tools/tv-debug/`):

- Pierwszy stream skończył się po 16 s rozłączeniem ENet od hosta (TV responsywny, bez zawieszenia). Drugi działał
  33,5 min (od 18:33:24 do 19:06:51 UTC) i się **zawiesił**. Sam profil 9.0 + jQuery 4 nie daje więc powtarzalnego
  freeza po starcie streama: ten sam typ zawieszenia występuje na profilu legacy (sekcja 10), a tu po kilkudziesięciu
  minutach. Brak błędów JS w logu. Samo `7eff49d` nie jest przyczyną.
- Sygnatura identyczna jak zawieszenie 3 z sekcji 10, bez trapu wasm: sześć wątków czeka w `malloc` (główny w
  `std::string::reserve`, kontrolny ENet w `enet_peer_queue_acknowledgement`, wejście kontrolera, wysyłka wejścia ENet,
  statystyki strat, odbiór wideo), pozostałe na zwykłych kolejkach, odbiór audio pracuje. Słowo blokady alokatora
  `0x8000000A` pod adresem 2666176, **`_m_waiters = 7` przy sześciu widocznych czekających**, tak samo jak za pierwszym
  razem.
- Zwolnienie blokady (`Atomics.store(0)` i `_emscripten_futex_wake`) obudziło sześć wątków i aplikację, ale host zdążył
  w międzyczasie zerwać sesję (po ok. 2,5 min ciszy, `streamTerminated: -1`).

**Tym razem sterta jest uszkodzona, i widać czym.** Skan łańcucha chunków zatrzymał się na chunku 1280 B pod adresem
21632104 (0x14A1468): jego nagłówek mówi „wolny", ale stopka się nie zgadza, a nagłówek następnego chunka to losowe
bajty (`head=2960565264`). W treści tego chunka, dokładnie tam, gdzie wolny chunk ma wskaźniki `fd`/`bk`, leży
**nagłówek pakietu RTP wideo** (`90 00 8c 38 8c 24 c2 0a 00 00 00 00 …`), a po nim ok. 1400 bajtów skompresowanych danych,
które wychodzą poza chunk i nadpisują nagłówek następnego. Pakiet wideo zapisany w chunku mniejszym niż bufor pakietu
(`StreamConfig.packetSize` 1392, bufor `1392 + 16 + sizeof(RTPV_QUEUE_ENTRY)` = 1448 B, czyli chunk 1456 B).

To przesuwa podejrzenie z alokatora na ścieżkę odbioru wideo: albo bufor pakietu został zwolniony i nadal był używany
(`VideoReceiveThreadProc` → `RtpvAddPacket` → kolejka FEC → depakietyzator), albo odbiór UDP zapisuje więcej niż
dostał. Odbiór idzie przez `wasm_recvfrom`, czyli natywne wiązanie hosta Samsunga (`tizentvwasm.SocketsHostBindings.
recvFrom`, `library_tizen_socket_host.js`), którego kodu nie ma w źródłach toolchainu. Przejrzano kod
`VideoStream.c` i `RtpVideoQueue.c` (`RtpvAddPacket`, `reconstructFrame`, własność bufora) i nie znaleziono w nim
oczywistego błędu własności: bufor przechodzi do kolejki tylko przy `RTPF_RET_QUEUED`, odrzucone pakiety są ponownie
używane. Nie wykluczono ścieżki FEC (bufor odzyskanego pakietu ma ten sam rozmiar) ani zbiegu z `notifyFrameLost`.

**Dalsze kroki, od najtańszego:**

1. Build diagnostyczny z kanarkiem za buforem pakietu wideo (`bufferSize + 16` z wzorcem na końcu), sprawdzanym tuż po
   `recvUdpSocket` i przy każdym `free` bufora pakietu. Rozstrzygnie, czy zapis wychodzi poza bufor od razu po odbiorze
   (wiązanie Samsunga), czy dopiero później (use-after-free w kolejce lub depakietyzatorze), i zaloguje wtedy rozmiar,
   numer sekwencyjny i ramkę.
2. Walker sterty rozszerzony o sprawdzanie wolnych chunków (wskaźniki `fd`/`bk` muszą wskazywać na chunk lub kosz),
   żeby takie uszkodzenie wykrywać w ciągu 15 s od zapisu, a nie dopiero przy zawieszeniu.
3. Guard z sekcji 11 jako zabezpieczenie niezależne od przyczyny, po sprawdzeniu na TV (`futex_guard_probe.js`).

