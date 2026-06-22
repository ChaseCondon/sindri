/// Maps tree-sitter standard capture names to Sindri token names.
/// The CM6 bridge applies class `cm-ts-{token}` per ADR-0019/ADR-0041 §6.
/// Capture names arrive with the leading `@` stripped (or not — we handle both).
pub fn capture_to_token(name: &str) -> Option<&'static str> {
    let n = name.strip_prefix('@').unwrap_or(name);
    // Exact matches first for the most common names.
    let token = match n {
        "keyword" | "keyword.control" | "keyword.operator" | "keyword.return"
        | "keyword.exception" | "keyword.conditional" | "keyword.repeat"
        | "keyword.import" | "keyword.storage" | "keyword.function"
        | "keyword.directive" | "keyword.coroutine" | "keyword.debug"
        => "keyword",

        "function" | "function.call" | "function.method" | "function.method.call"
        | "function.builtin" | "function.macro"
        => "function",

        "string" | "string.special" | "string.escape" | "string.regexp"
        | "string.doc" | "string.special.symbol"
        => "string",

        "comment" | "comment.line" | "comment.block"
        | "comment.block.documentation"
        => "comment",

        "type" | "type.builtin" | "type.definition" | "type.parameter"
        | "type.enum.variant" | "type.qualifier"
        => "type",

        "variable" | "variable.member" | "variable.parameter" | "variable.builtin"
        | "variable.special"
        => "variable",

        "number" | "number.float" => "number",

        "constant" | "constant.builtin" | "constant.character"
        | "constant.character.escape" | "constant.macro" | "constant.numeric"
        => "constant",

        "operator" | "operator.special" => "operator",

        "property" | "property.definition" => "property",

        "punctuation" | "punctuation.delimiter" | "punctuation.bracket"
        | "punctuation.special"
        => "punctuation",

        "attribute" | "attribute.builtin" | "attribute.inner" => "attribute",

        "namespace" | "namespace.builtin" => "namespace",

        "tag" | "tag.builtin" | "tag.attribute" | "tag.delimiter" => "tag",

        "constructor" => "constructor",
        "embedded"    => "embedded",
        "label"       => "label",
        "module"      => "module",

        _ => {
            // Fall back to the first dot-segment (e.g. "keyword.special" → "keyword").
            match n.split('.').next()? {
                "keyword"     => "keyword",
                "function"    => "function",
                "string"      => "string",
                "comment"     => "comment",
                "type"        => "type",
                "variable"    => "variable",
                "number"      => "number",
                "constant"    => "constant",
                "operator"    => "operator",
                "property"    => "property",
                "punctuation" => "punctuation",
                "attribute"   => "attribute",
                "namespace"   => "namespace",
                "tag"         => "tag",
                _             => return None,
            }
        }
    };
    Some(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_exact_names() {
        assert_eq!(capture_to_token("@keyword"), Some("keyword"));
        assert_eq!(capture_to_token("@string.escape"), Some("string"));
        assert_eq!(capture_to_token("@comment.block.documentation"), Some("comment"));
        assert_eq!(capture_to_token("@function.call"), Some("function"));
    }

    #[test]
    fn falls_back_to_first_segment() {
        assert_eq!(capture_to_token("@keyword.special.new"), Some("keyword"));
        assert_eq!(capture_to_token("@type.foo.bar"), Some("type"));
    }

    #[test]
    fn handles_at_prefix_or_not() {
        assert_eq!(capture_to_token("keyword"), Some("keyword"));
        assert_eq!(capture_to_token("@keyword"), Some("keyword"));
    }

    #[test]
    fn returns_none_for_unknown() {
        assert_eq!(capture_to_token("@something_unknown"), None);
        assert_eq!(capture_to_token("@"), None);
    }
}
