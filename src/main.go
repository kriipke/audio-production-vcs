package main

import (
    "bytes"
    "context"
    "embed"
    "encoding/json"
    "errors"
    "fmt"
    "log"
    "net/http"
    "os"
    "path"
    "regexp"
    "sort"
    "strings"
    "sync"
    "time"
)

//go:embed web/*
var webFS embed.FS

// ====== Dropbox Types ======

type dbxEntry struct {
    Tag            string    `json:".tag"`
    Name           string    `json:"name"`
    PathLower      string    `json:"path_lower"`
    PathDisplay    string    `json:"path_display"`
    ID             string    `json:"id"`
    ClientModified time.Time `json:"client_modified"`
    ServerModified time.Time `json:"server_modified"`
    Size           int64     `json:"size"`
}

type dbxListResp struct {
    Entries []dbxEntry `json:"entries"`
    Cursor  string     `json:"cursor"`
    HasMore bool       `json:"has_more"`
}

type dbxTempLinkResp struct {
    Link     string   `json:"link"`
    Metadata dbxEntry `json:"metadata"`
}

// ====== AVCS Parsing ======

// TRACK: [A-Z0-9_]+
// T1/T2: 4 digits + A|P (HHMM A/P)
// STEM: [A-Z0-9_]+

var (
    reAbleton  = regexp.MustCompile(`^(?P<track>[A-Z0-9_]+)-(?P<t1>[0-9]{4}[AP])\.(?P<ext>als|wav|mp3)$`)
    reStems    = regexp.MustCompile(`^(?P<track>[A-Z0-9_]+)-(?P<t1>[0-9]{4}[AP])-(?P<t2>[0-9]{4}[AP])-(?P<stem>[A-Z0-9_]+)\.wav$`)
    reUnmaster = regexp.MustCompile(`^(?P<track>[A-Z0-9_]+)-(?P<t1>[0-9]{4}[AP])-(?P<t2>[0-9]{4}[AP])-\[unmastered\]\.wav$`)
    reMaster   = regexp.MustCompile(`^(?P<track>[A-Z0-9_]+)-(?P<t1>[0-9]{4}[AP])-(?P<t2>[0-9]{4}[AP])-(?P<idx>FINAL|[1-9][0-9]*)\.wav$`)
)

func rxGroup(rx *regexp.Regexp, s string, name string) string {
    m := rx.FindStringSubmatch(s)
    if m == nil { return "" }
    for i, n := range rx.SubexpNames() {
        if n == name { return m[i] }
    }
    return ""
}

// ====== In-Memory Index ======

type FileRef struct {
    Name           string    `json:"name"`
    Path           string    `json:"path"`
    Size           int64     `json:"size"`
    ServerModified time.Time `json:"server_modified"`
}

type AbletonSnap struct {
    T1     string   `json:"t1"`
    ALS    *FileRef `json:"als,omitempty"`
    WAV    *FileRef `json:"wav,omitempty"`
    MP3    *FileRef `json:"mp3,omitempty"`
    Latest time.Time `json:"latest"`
}

type StemsSet struct {
    T1     string    `json:"t1"`
    T2     string    `json:"t2"`
    Stems  []FileRef `json:"stems"`
    Latest time.Time `json:"latest"`
}

type Mix struct {
    T1     string   `json:"t1"`
    T2     string   `json:"t2"`
    File   FileRef  `json:"file"`
    Latest time.Time `json:"latest"`
}

type MasterSet struct {
    T1        string      `json:"t1"`
    T2        string      `json:"t2"`
    Candidates []FileRef  `json:"candidates"`
    Final     *FileRef    `json:"final,omitempty"`
    Latest    time.Time   `json:"latest"`
}

type Track struct {
    Name     string       `json:"name"`
    Ableton  []AbletonSnap `json:"ableton"`
    Stems    []StemsSet    `json:"stems"`
    Mixes    []Mix         `json:"mixes"`
    Masters  []MasterSet   `json:"masters"`
}

type Server struct {
    dropboxToken string
    dropboxRoot  string
    bindAddr     string

    mu     sync.RWMutex
    tracks map[string]*Track // key: TRACK name
}

func main() {
    s := &Server{
        dropboxToken: strings.TrimSpace(os.Getenv("DROPBOX_TOKEN")),
        dropboxRoot:  os.Getenv("DROPBOX_ROOT"),
        bindAddr:     os.Getenv("BIND_ADDR"),
        tracks:       map[string]*Track{},
    }
    if s.dropboxToken == "" {
        log.Fatal("DROPBOX_TOKEN env var is required")
    }
    if s.dropboxRoot == "" { s.dropboxRoot = "/Tracks" }
    if s.bindAddr == "" { s.bindAddr = ":8080" }

    log.Printf("Indexing Dropbox root: %s", s.dropboxRoot)
    if err := s.reindex(context.Background()); err != nil {
        log.Printf("initial index error: %v", err)
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/api/tracks", s.handleListTracks)
    mux.HandleFunc("/api/tracks/", s.handleGetTrack) // /api/tracks/{name}
    mux.HandleFunc("/api/link", s.handleTempLink)    // ?path=/Tracks/...
    mux.HandleFunc("/api/reindex", s.handleReindex)

    // Static UI
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        p := r.URL.Path
        if p == "/" {
            serveFS(w, "web/index.html")
            return
        }
        // serve web assets
        if strings.HasPrefix(p, "/web/") {
            serveFS(w, strings.TrimPrefix(p, "/"))
            return
        }
        http.NotFound(w, r)
    })

    srv := &http.Server{ Addr: s.bindAddr, Handler: logRequests(mux) }
    log.Printf("Listening on %s", s.bindAddr)
    log.Fatal(srv.ListenAndServe())
}

func serveFS(w http.ResponseWriter, name string) {
    b, err := webFS.ReadFile(name)
    if err != nil { http.NotFound(w, nil); return }
    if strings.HasSuffix(name, ".js") { w.Header().Set("Content-Type", "application/javascript") }
    if strings.HasSuffix(name, ".css") { w.Header().Set("Content-Type", "text/css") }
    w.Write(b)
}

func logRequests(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        t := time.Now()
        next.ServeHTTP(w, r)
        log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(t))
    })
}

// ====== Handlers ======

func (s *Server) handleListTracks(w http.ResponseWriter, r *http.Request) {
    s.mu.RLock(); defer s.mu.RUnlock()
    type summary struct {
        Name         string `json:"name"`
        AbletonCount int    `json:"ableton_count"`
        StemSets     int    `json:"stem_sets"`
        Mixes        int    `json:"mixes"`
        MasterSets   int    `json:"master_sets"`
    }
    var out []summary
    for name, t := range s.tracks {
        out = append(out, summary{
            Name: name, AbletonCount: len(t.Ableton), StemSets: len(t.Stems), Mixes: len(t.Mixes), MasterSets: len(t.Masters),
        })
    }
    sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
    writeJSON(w, out)
}

func (s *Server) handleGetTrack(w http.ResponseWriter, r *http.Request) {
    // Expect /api/tracks/{name}
    parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/tracks/"), "/")
    if len(parts) < 1 || parts[0] == "" { http.NotFound(w, r); return }
    name := parts[0]
    s.mu.RLock(); t := s.tracks[name]; s.mu.RUnlock()
    if t == nil { http.Error(w, "track not found", 404); return }
    writeJSON(w, t)
}

func (s *Server) handleReindex(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost { http.Error(w, "POST required", 405); return }
    if err := s.reindex(r.Context()); err != nil {
        http.Error(w, err.Error(), 500); return
    }
    writeJSON(w, map[string]any{"status":"ok"})
}

func (s *Server) handleTempLink(w http.ResponseWriter, r *http.Request) {
    p := r.URL.Query().Get("path")
    if p == "" || !strings.HasPrefix(p, s.dropboxRoot) && !strings.HasPrefix(strings.ToLower(p), strings.ToLower(s.dropboxRoot)) {
        http.Error(w, "bad path", 400); return
    }
    link, err := s.dbxTempLink(r.Context(), p)
    if err != nil { http.Error(w, err.Error(), 502); return }
    writeJSON(w, map[string]string{"url": link})
}

// ====== Indexer ======

func (s *Server) reindex(ctx context.Context) error {
    entries, err := s.dbxListAll(ctx, s.dropboxRoot)
    if err != nil { return err }

    tracks := map[string]*Track{}
    // Track folders are immediate children of root; but we will infer from file names/folders under root as well.
    for _, e := range entries {
        if e.Tag != "file" { continue }
        base := path.Base(e.PathDisplay)
        // Identify by regexes in priority order.
        switch {
        case reAbleton.MatchString(base):
            tr := rxGroup(reAbleton, base, "track")
            t1 := rxGroup(reAbleton, base, "t1")
            ext := rxGroup(reAbleton, base, "ext")
            T := ensureTrack(tracks, tr)
            snap := findOrCreateSnap(&T.Ableton, t1)
            ref := FileRef{Name: base, Path: e.PathDisplay, Size: e.Size, ServerModified: e.ServerModified}
            switch ext {
            case "als": snap.ALS = &ref
            case "wav": snap.WAV = &ref
            case "mp3": snap.MP3 = &ref
            }
            latest := e.ServerModified
            if latest.After(snap.Latest) { snap.Latest = latest }
            // write back
            replaceSnap(&T.Ableton, *snap)

        case reStems.MatchString(base):
            tr := rxGroup(reStems, base, "track")
            t1 := rxGroup(reStems, base, "t1")
            t2 := rxGroup(reStems, base, "t2")
            stem := rxGroup(reStems, base, "stem")
            T := ensureTrack(tracks, tr)
            set := findOrCreateStems(&T.Stems, t1, t2)
            set.Stems = append(set.Stems, FileRef{Name: stem + ".wav", Path: e.PathDisplay, Size: e.Size, ServerModified: e.ServerModified})
            if e.ServerModified.After(set.Latest) { set.Latest = e.ServerModified }
            replaceStems(&T.Stems, *set)

        case reUnmaster.MatchString(base):
            tr := rxGroup(reUnmaster, base, "track")
            t1 := rxGroup(reUnmaster, base, "t1")
            t2 := rxGroup(reUnmaster, base, "t2")
            T := ensureTrack(tracks, tr)
            m := Mix{T1: t1, T2: t2, File: FileRef{Name: base, Path: e.PathDisplay, Size: e.Size, ServerModified: e.ServerModified}, Latest: e.ServerModified}
            T.Mixes = append(T.Mixes, m)

        case reMaster.MatchString(base):
            tr := rxGroup(reMaster, base, "track")
            t1 := rxGroup(reMaster, base, "t1")
            t2 := rxGroup(reMaster, base, "t2")
            idx := rxGroup(reMaster, base, "idx")
            T := ensureTrack(tracks, tr)
            set := findOrCreateMaster(&T.Masters, t1, t2)
            ref := FileRef{Name: base, Path: e.PathDisplay, Size: e.Size, ServerModified: e.ServerModified}
            if strings.EqualFold(idx, "FINAL") {
                set.Final = &ref
            } else {
                set.Candidates = append(set.Candidates, ref)
            }
            if e.ServerModified.After(set.Latest) { set.Latest = e.ServerModified }
            replaceMaster(&T.Masters, *set)
        default:
            // ignore other files (refs, prints, sessions, manifests, etc.)
        }
    }

    // Sort collections for stable output
    for _, t := range tracks {
        sort.SliceStable(t.Ableton, func(i, j int) bool { return t.Ableton[i].T1 < t.Ableton[j].T1 })
        sort.SliceStable(t.Stems, func(i, j int) bool {
            if t.Stems[i].T1 == t.Stems[j].T1 { return t.Stems[i].T2 < t.Stems[j].T2 }
            return t.Stems[i].T1 < t.Stems[j].T1
        })
        sort.SliceStable(t.Mixes, func(i, j int) bool {
            if t.Mixes[i].T1 == t.Mixes[j].T1 { return t.Mixes[i].T2 < t.Mixes[j].T2 }
            return t.Mixes[i].T1 < t.Mixes[j].T1
        })
        sort.SliceStable(t.Masters, func(i, j int) bool {
            if t.Masters[i].T1 == t.Masters[j].T1 { return t.Masters[i].T2 < t.Masters[j].T2 }
            return t.Masters[i].T1 < t.Masters[j].T1
        })
        for i := range t.Masters {
            sort.SliceStable(t.Masters[i].Candidates, func(a, b int) bool { return t.Masters[i].Candidates[a].Name < t.Masters[i].Candidates[b].Name })
        }
    }

    s.mu.Lock(); s.tracks = tracks; s.mu.Unlock()
    log.Printf("Indexed %d tracks", len(tracks))
    return nil
}

func ensureTrack(m map[string]*Track, name string) *Track {
    t := m[name]
    if t == nil { t = &Track{Name: name}; m[name] = t }
    return t
}

func findOrCreateSnap(list *[]AbletonSnap, t1 string) *AbletonSnap {
    for i := range *list {
        if (*list)[i].T1 == t1 { return &(*list)[i] }
    }
    *list = append(*list, AbletonSnap{T1: t1})
    return &(*list)[len(*list)-1]
}

func replaceSnap(list *[]AbletonSnap, v AbletonSnap) {
    for i := range *list { if (*list)[i].T1 == v.T1 { (*list)[i] = v; return } }
}

func findOrCreateStems(list *[]StemsSet, t1, t2 string) *StemsSet {
    for i := range *list { if (*list)[i].T1 == t1 && (*list)[i].T2 == t2 { return &(*list)[i] } }
    *list = append(*list, StemsSet{T1: t1, T2: t2})
    return &(*list)[len(*list)-1]
}

func replaceStems(list *[]StemsSet, v StemsSet) {
    for i := range *list { if (*list)[i].T1 == v.T1 && (*list)[i].T2 == v.T2 { (*list)[i] = v; return } }
}

func findOrCreateMaster(list *[]MasterSet, t1, t2 string) *MasterSet {
    for i := range *list { if (*list)[i].T1 == t1 && (*list)[i].T2 == t2 { return &(*list)[i] } }
    *list = append(*list, MasterSet{T1: t1, T2: t2})
    return &(*list)[len(*list)-1]
}

func replaceMaster(list *[]MasterSet, v MasterSet) {
    for i := range *list { if (*list)[i].T1 == v.T1 && (*list)[i].T2 == v.T2 { (*list)[i] = v; return } }
}

// ====== Dropbox HTTP (no external deps) ======

func (s *Server) dbxListAll(ctx context.Context, root string) ([]dbxEntry, error) {
    var out []dbxEntry
    body := map[string]any{
        "path": root,
        "recursive": true,
        "include_non_downloadable_files": false,
    }
    resp, err := s.dbxRPC(ctx, "/2/files/list_folder", body)
    if err != nil { return nil, err }
    var lr dbxListResp
    if err := json.Unmarshal(resp, &lr); err != nil { return nil, err }
    out = append(out, lr.Entries...)
    for lr.HasMore {
        resp, err = s.dbxRPC(ctx, "/2/files/list_folder/continue", map[string]string{"cursor": lr.Cursor})
        if err != nil { return nil, err }
        lr = dbxListResp{}
        if err := json.Unmarshal(resp, &lr); err != nil { return nil, err }
        out = append(out, lr.Entries...)
    }
    return out, nil
}

func (s *Server) dbxTempLink(ctx context.Context, p string) (string, error) {
    resp, err := s.dbxRPC(ctx, "/2/files/get_temporary_link", map[string]string{"path": p})
    if err != nil { return "", err }
    var lr dbxTempLinkResp
    if err := json.Unmarshal(resp, &lr); err != nil { return "", err }
    if lr.Link == "" { return "", errors.New("no temp link returned") }
    return lr.Link, nil
}

func (s *Server) dbxRPC(ctx context.Context, endpoint string, payload any) ([]byte, error) {
    b, _ := json.Marshal(payload)
    req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.dropboxapi.com"+endpoint, bytes.NewReader(b))
    req.Header.Set("Authorization", "Bearer "+s.dropboxToken)
    req.Header.Set("Content-Type", "application/json")
    httpClient := &http.Client{ Timeout: 30 * time.Second }
    res, err := httpClient.Do(req)
    if err != nil { return nil, err }
    defer res.Body.Close()
    buf := new(bytes.Buffer); buf.ReadFrom(res.Body)
    if res.StatusCode != 200 {
        return nil, fmt.Errorf("dropbox %s -> %s: %s", endpoint, res.Status, truncate(buf.String(), 400))
    }
    return buf.Bytes(), nil
}

func truncate(s string, n int) string { if len(s) <= n { return s }; return s[:n] + "…" }

func writeJSON(w http.ResponseWriter, v any) {
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Cache-Control", "no-store")
    enc := json.NewEncoder(w)
    enc.SetIndent("", "  ")
    if err := enc.Encode(v); err != nil {
        http.Error(w, err.Error(), 500)
    }
}

