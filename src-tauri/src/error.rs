use std::fmt::Display;

pub type Res<T> = Result<T, String>;

pub trait Ctx<T> {
    fn ctx(self, what: impl FnOnce() -> String) -> Res<T>;
}

impl<T, E: Display> Ctx<T> for Result<T, E> {
    fn ctx(self, what: impl FnOnce() -> String) -> Res<T> {
        self.map_err(|e| format!("{}: {}", what(), e))
    }
}

impl<T> Ctx<T> for Option<T> {
    fn ctx(self, what: impl FnOnce() -> String) -> Res<T> {
        self.ok_or_else(what)
    }
}
