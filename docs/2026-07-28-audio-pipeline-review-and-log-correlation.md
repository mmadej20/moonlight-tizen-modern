# Przegląd toru audio i korelacja z logiem sesji z 2026-07-28

## Zakres

Dokument łączy:

- przegląd toru audio od RTP/FEC przez Opus do Samsung
  `ElementaryMediaTrack`;
- analizę logu
  `tools/moonlight-tv-logs/moonlight-previous-session-2026-07-28T17-30-51.836Z.log`;
- ocenę wpływu zmian wprowadzonych 2026-07-28:
  - `1eb3dfb` — `fix: soften audio synchronization drops`;
  - `2385e7a` — `fix: preserve video PTS across pacing resets`.

Analizowany log pochodzi ze starej implementacji. Potwierdza to obecność
pojedynczych wpisów `Dropping audio packet to avoid overflow`, usuniętych przez
commit `1eb3dfb` i zastąpionych zagregowanym komunikatem
`Audio sync correction dropped ...`.

Źródło ma SHA-256:
`0049912E194A48D6B573287FD89E27FCAA89B4D9374E79C9CA3C504181983A2A`.

Log kończy się bez normalnego zamknięcia sesji i ma uszkodzone końcowe bajty,
dlatego brak zdarzenia pod koniec pliku nie jest dowodem, że ono nie wystąpiło.

## Wniosek

Dzisiejsza poprawka Audio Sync jest bezpośrednio związana z głównym problemem
widocznym w logu i powinna dać wyraźną poprawę:

- stary algorytm wyrzucił 2057 pakietów audio;
- przy pakietach po 5 ms odpowiada to 10,285 s usuniętego materiału;
- w ostatnim wpisie różnica `NTP - PTS` wynosi 10,356 s;
- różnica między skumulowanym czasem dropów a obserwowanym przesunięciem wynosi
  tylko około 71 ms.

Oznacza to, że niemal całe końcowe przesunięcie osi czasu audio można wyjaśnić
dropami wykonywanymi przez stary Audio Sync.

Commit `1eb3dfb` podnosi próg miękkiej korekcji ze 100 do 200 ms, dodaje
histerezę 120 ms, ogranicza miękkie dropowanie do jednego pakietu na dziesięć
i agreguje logi. Powinno to radykalnie ograniczyć liczbę wyrzuconych pakietów
oraz obciążenie loggera na wątku odbioru audio.

Nie jest to jednak rozwiązanie kompletne. Każdy pakiet nadal celowo wyrzucony
przez nowy kontroler nie przesuwa `s_pktPts`. Jeżeli twarda korekcja nadal
będzie aktywowana, oś czasu audio nadal będzie skracana, tylko wolniej.

## Dane z logu

| Metryka | Wynik |
|---|---:|
| Czas ostatniego poprawnego wpisu | 642578 ms |
| Dropy starego Audio Sync | 2057 |
| Nominalny czas wyrzuconego audio | 10,285 s |
| `NTP - PTS` przy pierwszym dropie | 106 ms |
| `NTP - PTS` przy ostatnim dropie | 10,356 s |
| Serie dropów oddzielone przerwą ponad 1 s | 15 |
| Dropy w pobliżu jawnych strat sieciowych | 355, czyli 17,3% |
| Dropy poza tymi okresami | 1702 |
| Nieudane bloki audio FEC | 20 |
| Raporty luk sekwencji audio | 21 |
| Łączna liczba brakujących pakietów raportowana przez luki | 40, czyli 200 ms |
| Raporty utraty ramek wideo | 52 |
| Łączna liczba utraconych ramek wideo | 330 |
| Największa pojedyncza utrata wideo | 96 ramek, około 1,6 s |
| Requesty IDR | 57, w tym request startowy |
| Wpisy `Waiting for IDR frame` | 394 |
| `Video decode unit queue overflow` | 0 |
| `Audio packet queue overflow` | 0 |
| `Append audio packet failed` | 0 |
| Otwarcia ścieżki audio | 1 |
| Zamknięcia ścieżki audio po uruchomieniu | 0 |

Największe serie starego Audio Sync:

| Zakres czasu | Liczba dropów | `NTP - PTS` na końcu |
|---|---:|---:|
| 219445–226516 ms | 273 | 1,509 s |
| 279640–290203 ms | 417 | 3,866 s |
| 339954–349423 ms | 405 | 6,406 s |
| 399950–409716 ms | 404 | 9,064 s |
| 520583–524455 ms | 175 | 9,943 s |

Tylko 17,3% dropów Audio Sync wystąpiło w obrębie jednej sekundy od skupisk
jawnych błędów RTP/FEC lub utraty ramek wideo. Agresywna korekcja nie była więc
wyłącznie skutkiem dwóch widocznych awarii sieci. Uruchamiała się także podczas
zwykłych burstów dostarczania pakietów lub krótkich zatrzymań odbiorcy.

## Korelacja z dzisiejszymi zmianami

### 1. Agresywne dropowanie Audio Sync

**Status: potwierdzone przez log; dzisiejszy patch powinien mocno pomóc.**

Stary kod rozpoczynał ciągłe dropowanie po przekroczeniu zaledwie 100 ms
oszacowanego bufora. Każdy drop:

- usuwał jeden pakiet po 5 ms;
- nie przesuwał audio PTS;
- wykonywał osobny synchroniczny wpis diagnostyczny.

W logu wystąpiło 2057 takich operacji. Ich nominalny czas niemal dokładnie
odpowiada końcowemu opóźnieniu `PTS` względem zegara lokalnego.

Nowy kontroler w `wasm/audio_sync.hpp`:

- zaczyna miękką korekcję przy 200 ms;
- kończy ją po zejściu do 120 ms;
- miękko wyrzuca najwyżej jeden pakiet na dziesięć;
- przechodzi do ciągłych dropów dopiero od 350 ms;
- nalicza backlog wyłącznie po udanym Opus decode i udanym appendzie;
- loguje sumę dropów najwyżej raz na sekundę.

To usuwa dwa konkretne źródła widoczne w starej sesji: drop storm oraz log storm.

### 2. Nadal skracana oś czasu przy celowym dropie

**Status: nowa korelacja z logiem; ograniczone, ale nie usunięte przez
`1eb3dfb`.**

Aktualny kod zwiększa `s_pktPts` tylko po udanym `AppendPacket()`. Miękki lub
twardy drop wraca wcześniej i nie zachowuje czasu źródłowego pakietu.

Jest to spójne z wynikiem starej sesji:

```text
2057 * 5 ms = 10,285 s
ostatnie NTP - PTS = 10,356 s
reszta = około 71 ms
```

Nowy limiter powinien wielokrotnie zmniejszyć liczbę takich przypadków, ale nie
zmienia ich semantyki. Następna poprawka powinna rozdzielić:

- źródłową oś czasu audio;
- oszacowanie ilości danych oczekujących w EMSS;
- strategię awaryjnego opróżnienia lub rebazowania ścieżki.

Samo przesuwanie PTS po dropie może zachować synchronizację treści, ale nie musi
zmniejszyć kolejki EMSS. Dlatego wymaga osobnego testu na urządzeniu i
uzgodnionej polityki kontrolowanego resetu/rebase przy twardym przepełnieniu.

### 3. Całkowicie utracony blok audio FEC

**Status: wzorzec potwierdzony w logu; niepoprawiony dzisiaj.**

O godzinie sesji `354813 ms` występuje:

```text
Network dropped audio data (expected 1784, but received 1788)
```

Brakuje dokładnie czterech kolejnych pakietów:

- `1784` jest początkiem bloku czteropakietowego;
- `1788` jest początkiem następnego bloku;
- bezpośrednio przed luką nie ma komunikatu
  `Unable to recover audio data block`.

Jest to wzorzec zgodny z całkowicie nieotrzymanym blokiem FEC. W
`handleMissingPackets()` kolejka przeskakuje wtedy
`nextRtpSequenceNumber` do następnego znanego bloku. Placeholdery długości zero,
uruchamiające Opus PLC, są tworzone tylko dla braków wewnątrz bloku, który
istnieje w kolejce.

W efekcie pełna utrata bloku może pominąć cztery callbacki PLC i skrócić
źródłową oś czasu audio o kolejne 20 ms.

Pozostałe raporty obejmują częściowo odebrane, ale niemożliwe do odzyskania
bloki FEC. Nie należy zakładać, że każdy z 40 raportowanych brakujących pakietów
skrócił timeline, ponieważ dla części z nich kolejka generuje placeholdery PLC.

Potrzebny patch:

1. wygenerować ograniczoną liczbę placeholderów PLC dla pełnej luki blokowej;
2. przetestować pojedynczy i wielokrotny brak całego bloku;
3. przetestować zawinięcie 16-bitowego numeru RTP;
4. upewnić się, że częściowa strata nie generuje PLC dwukrotnie.

### 4. Straty wideo i dzisiejsza poprawka HEVC timing

**Status: log zawiera scenariusz, dla którego patch jest istotny; patch nie
naprawia samej utraty sieciowej.**

Sesja używała:

- HEVC Main Level 5.1;
- 3840x2160 przy 60 FPS;
- 43 Mbps;
- wyłączonego frame pacing.

Pomimo wyłączonego pacingu `UpdatePresentationTimestamp()` nadal oblicza PTS
przekazywany do Samsung EMSS. Wyłączenie opcji pomija tylko lokalne oczekiwanie
na docelowy czas prezentacji.

Log zawiera pięć pojedynczych raportów utraty dłuższej niż próg 250 ms starego
algorytmu:

- 96 ramek — około 1,6 s;
- 32 ramki — około 533 ms;
- 27 ramek — około 450 ms;
- 20 ramek — około 333 ms;
- 16 ramek — około 267 ms.

Jeżeli po takim okresie kolejny zaakceptowany decode unit miał odpowiednio duży
skok timestampu, stary kod resetował lokalny pacing oraz ścieśniał media PTS.
Commit `2385e7a` zachowuje dodatnią lukę w media PTS i resetuje wyłącznie lokalną
bazę pacingu. Ma to znaczenie również przy wyłączonym pacingu, ponieważ PTS
nadal trafia do `ElementaryMediaPacket`.

Patch powinien zapobiec dodatkowej kompresji osi czasu wideo po dużych lukach,
ale nie zmniejszy:

- liczby utraconych ramek;
- liczby requestów IDR;
- czasu oczekiwania na IDR;
- strat audio RTP/FEC.

W tej sesji nie było `Video decode unit queue overflow`. Widoczne problemy wideo
pochodziły z utraty/depakietyzacji i oczekiwania na IDR, a nie z przepełnienia
15-ramkowej kolejki dekodera.

### 5. `CAPABILITY_DIRECT_SUBMIT`

**Status: ryzyko pozostaje; log nie potwierdza go jako głównej przyczyny.**

Przy `CAPABILITY_DIRECT_SUBMIT` wątek odbioru UDP wykonuje bezpośrednio:

- obsługę FEC i deszyfrowanie;
- dekodowanie Opus;
- `ElementaryMediaTrack::AppendPacket()`;
- diagnostykę.

Stare 2057 synchronicznych wpisów o dropie wykonywano właśnie na tej gorącej
ścieżce. Ich agregacja w `1eb3dfb` usuwa jeden konkretny wzmacniacz problemu.

Nie można jednak na podstawie tego logu stwierdzić, że callback audio blokował
odbiór UDP:

- największe awarie około 292–298 s i 352–356 s obejmowały jednocześnie audio
  i wideo, co wskazuje na problem wspólnego transportu, hosta lub sieci;
- 1702 dropy Audio Sync wystąpiły poza tymi awariami, ale były decyzjami
  lokalnego kontrolera, a nie dowodem utraty UDP;
- log nie zawiera czasów Opus decode ani `AppendPacket()`.

Przed usunięciem `DIRECT_SUBMIT` należy dodać zagregowane pomiary czasu FEC,
Opus, appendu i całego callbacku. Obecna alternatywna kolejka ma limit 30
pakietów i po przepełnieniu opróżnia całą zawartość, więc proste wyłączenie
flagi może zastąpić jeden typ przerwy innym, około 150-milisekundowym.

### 6. Błąd Opus lub append

**Status: nieweryfikowalne w tym logu; niepoprawione dzisiaj.**

Nie ma wpisów `Append audio packet failed`, ale stary dekoder nie logował
`opus_multistream_decode() <= 0`. Brak wpisu nie wyklucza błędów dekodowania.

Przy błędzie Opus aktualny kod:

- zeruje bufor;
- nie appenduje ciszy;
- nie przesuwa PTS.

Każdy taki przypadek skraca timeline o 5 ms. Zalecane zachowanie to próba Opus
PLC, następnie jawna cisza albo kontrolowana polityka discontinuity, oraz
zagregowany licznik błędów.

Wynik appendu jest sprowadzany do `bool`, więc log nie rozróżnia
`kAppendIgnored` dla nieaktualnej sesji od realnego błędu urządzenia.

### 7. Zamknięcie i ponowne otwarcie tracka

**Status: problem kodu pozostaje, ale scenariusz nie wystąpił w logu.**

Po uruchomieniu widoczne jest jedno `AUDIO ElementaryMediaTrack::OnTrackOpen`
i brak późniejszego `OnTrackClosed` lub `OnSessionIdChanged`.

Log nie testuje więc suspend/resume. Kod nadal tylko zmienia
`m_AudioStarted` i session ID, bez resetu lub rebase:

- `s_pktPts`;
- kontrolera synchronizacji;
- `s_firstAppend`;
- `s_hasFirstFrame`.

Potrzebny jest osobny test na TV: rozpoczęcie streamu, przełączenie aplikacji,
powrót po kilku sekundach i kontrola zmian session ID oraz A/V sync.

### 8. Startowe odrzucenie 500 ms

**Status: jawnie potwierdzone, odziedziczone z moonlight-common-c.**

Log zawiera:

```text
Received first audio packet after 0 ms
Initial audio resync period: 500 milliseconds
```

Klient odebrał pierwszy pakiet bez oczekiwania, a mimo to odrzucił pierwsze
500 ms. Jest to zachowanie upstream służące opróżnieniu potencjalnego backlogu
GFE. Może powodować niepotrzebną ciszę na szybkim starcie Sunshine, ale nie
wyjaśnia późniejszych serii dropów.

Nie należy usuwać go bez pomiaru startowego backlogu i testu zgodności z GFE.

### 9. Rozmiar bufora i capabilities

**Status: problemy statyczne, niewidoczne w logu.**

- `std::vector<opus_int16>::resize()` otrzymuje liczbę bajtów zamiast elementów,
  co daje około dwukrotną nadalokację bufora.
- Renderer korzysta z `samplesPerFrame`, ale nie reklamuje
  `CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION`.
- Przy niskim bitrate host mógłby użyć pakietów 10 ms zamiast 5 ms i zmniejszyć
  liczbę callbacków mniej więcej o połowę.
- `CAPABILITY_SLOW_OPUS_DECODER` należy rozważyć dopiero po pomiarach 5.1/7.1,
  ponieważ wpływa na negocjację jakości surround.

## Macierz ustaleń

| Problem | Dowód w logu | Dzisiejszy patch | Pozostała praca |
|---|---|---|---|
| Agresywne Audio Sync | Mocny, 2057 dropów | Duża oczekiwana poprawa | Test TV |
| Kompresja PTS przez sync drop | Mocny, około 10,285 s vs 10,356 s | Ograniczona częstotliwość | Rozdzielić source PTS i queue control |
| Pełny brak bloku FEC | Mocny wzorzec `1784 -> 1788` | Brak | PLC dla pełnego bloku |
| Częściowe straty FEC | 20 nieodzyskanych bloków | Brak | Testy FEC/PLC i statystyki |
| Duże luki HEVC PTS | Mocny scenariusz strat >250 ms | Naprawione mapowanie PTS | Test TV po utracie |
| Rzeczywista utrata wideo/IDR | 330 ramek, 57 IDR | Brak | Diagnostyka transportu/hosta |
| Koszt per-packet logowania | 2057 wpisów | Zagregowane logi | Pomiar callbacku |
| Direct submit blokuje UDP | Brak jednoznacznego dowodu | Brak | Instrumentacja czasów |
| Błąd Opus skraca PTS | Brak danych, stary kod milczy | Brak | PLC/cisza i licznik |
| Reopen/suspend desynchronizuje audio | Scenariusz nie wystąpił | Brak | Epoch/rebase i test TV |
| Startowy drop 500 ms | Potwierdzony | Brak | Warunkować po pomiarach |
| Za duży bufor PCM | Niewidoczne w logu | Brak | Poprawić jednostki |

## Oczekiwany wynik po wdrożeniu dzisiejszego buildu

Najbardziej prawdopodobne efekty:

1. znacznie mniej słyszalnych przerw powodowanych przez sam Audio Sync;
2. brak tysięcy synchronicznych wpisów diagnostycznych;
3. stabilniejszy audio callback podczas krótkich burstów;
4. zachowanie prawidłowej osi czasu HEVC po dużych dodatnich lukach;
5. mniejsze narastanie różnicy audio/video.

Nie należy oczekiwać poprawy:

1. fizycznej jakości sieci i utraty UDP;
2. nieudanych bloków FEC;
3. oczekiwania na IDR po utracie wideo;
4. całkowicie utraconych bloków audio bez PLC;
5. suspend/resume tracka;
6. ewentualnego blokowania przez Opus lub Samsung `AppendPacket()`.

## Plan porównawczego testu na TV

Następna sesja powinna użyć tych samych parametrów:

- HEVC;
- 3840x2160;
- 60 FPS;
- około 43 Mbps;
- Audio Sync włączony;
- frame pacing wyłączony.

W nowym logu należy sprawdzić:

1. brak starego komunikatu `Dropping audio packet to avoid overflow`;
2. liczbę zagregowanych `Audio sync correction dropped ...`;
3. osobno liczbę dropów miękkich i twardych;
4. maksymalny raportowany lead;
5. liczbę `Network dropped audio data`;
6. liczbę `Unable to recover audio data block`;
7. liczbę utraconych ramek, requestów IDR i `Waiting for IDR frame`;
8. czy po pierwszej dużej luce audio i obraz pozostają zsynchronizowane;
9. czy powrót z suspend nie powoduje ciszy, odrzucenia appendów lub przesunięcia.

Runtime poprawy nie jest potwierdzony, dopóki nowy build nie zostanie
uruchomiony na TV i porównany z tym raportem.

## Referencje kodu

- `wasm/auddec.cpp` — dekodowanie Opus, PTS, append i Audio Sync;
- `wasm/audio_sync.hpp` — aktualny kontroler korekcji;
- `moonlight-common-c/src/RtpAudioQueue.c` — FEC i placeholdery PLC;
- `moonlight-common-c/src/AudioStream.c` — odbiór UDP i direct submit;
- `wasm/wasmplayer.cpp` — lifecycle tracków i przekazywanie HEVC do EMSS;
- `wasm/video_timing.hpp` — monotoniczna oś czasu wideo;
- `tests/audio_sync_tests.cpp` — testy kontrolera audio;
- `tests/video_timing_tests.cpp` — testy PTS i pacingu.

## Aktualizacja: telemetryka diagnostyczna po przeglądzie

Po przygotowaniu powyższego raportu dodano obserwowalność potrzebną do
potwierdzenia lub odrzucenia hipotez, bez zmiany zachowania transportu:

- `114cce7` dodaje `AudioPipelineStats` z czasami Opus, Samsung append i całego
  callbacku oraz z rozdzieleniem soft/hard dropów i wyników appendu;
- `c120b2a` dodaje `AudioTransportStats` z licznikami RTP, FEC, OOS, recovery,
  nieodtwarzalnych bloków, całych pominiętych bloków i PLC;
- `1be2de3` dodaje reason oraz stored/current session do lifecycle tracków audio
  i video.

To jest wyłącznie instrumentacja. W szczególności:

- `fullBlockSkipped` mierzy pakiety pomijane przy całkowitym braku bloku, ale
  nadal nie generuje dla nich PLC;
- nie zmieniono `CAPABILITY_DIRECT_SUBMIT`;
- nie zmieniono startowego dropu 500 ms;
- nie zmieniono zachowania po błędzie Opus ani reopenie tracka.

Stary punkt kontrolny `Audio sync correction dropped ...` został zastąpiony
jednym pełniejszym rekordem `AudioPipelineStats`, więc porównanie nowej sesji
powinno używać pól `softDrop`, `hardDrop`, `leadMaxMs` i `mediaOffsetMs`.

### Jak nowe logi rozstrzygną hipotezy

| Hipoteza | Sygnał potwierdzający | Sygnał osłabiający |
|---|---|---|
| Direct submit blokuje odbiór UDP | duże `callbackMaxUs`, równoczesne późniejsze straty RTP, spike w `decodeMaxUs` lub `appendMaxUs` | małe czasy callbacku podczas okien strat |
| Samsung append blokuje lub odrzuca pakiety | duże `appendMaxUs` albo `appendIgnored`/`appendBufferFull`/`appendOther` | szybkie, udane appendy w czasie przerw |
| Opus jest wąskim gardłem | duże `decodeMaxUs`, szczególnie dla 5.1/7.1 | stabilne krótkie decode przy dużym callbacku |
| Główną przyczyną jest sieć/FEC | wzrost `fecFailed`, `fullBlockSkipped`, `plc` oraz współbieżne problemy wideo | przerwy bez zmian liczników transportu |
| Session/reopen psuje timeline | close/change/open przed `appendIgnored` lub skokiem `mediaOffsetMs` | brak lifecycle eventów w oknie problemu |
| Audio Sync nadal jest zbyt agresywny | dużo `softDrop`/`hardDrop` przy rosnącym `mediaOffsetMs` | sporadyczne dropy tylko przy wysokim `leadMaxMs` |

### Minimalny zestaw do następnego porównania

Po sesji na TV należy zachować:

1. cały plik previous-session;
2. wszystkie `AudioPipelineStats`;
3. wszystkie `AudioTransportStats`;
4. wszystkie `AUDIO track`, `AUDIO session`, `VIDEO track` i `VIDEO session`;
5. wpisy o utracie audio, FEC, IDR oraz duże luki PTS w ich kontekście czasowym.

Dopiero taki log pozwoli stwierdzić, czy poprawa wynika z łagodniejszego Audio
Sync i zachowania PTS, czy problem nadal pochodzi głównie z transportu,
blokującego callbacku albo lifecycle EMSS.
