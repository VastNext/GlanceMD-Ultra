pub struct AppState {
    pub html: String,
    pub pending_files: Vec<String>,
    pub pending_content: Option<String>,
    pub pending_title: Option<String>,
    pub frontend_ready: bool,
    pub has_dirty_tabs: bool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            html: String::new(),
            pending_files: Vec::new(),
            pending_content: None,
            pending_title: None,
            frontend_ready: false,
            has_dirty_tabs: false,
        }
    }
}
