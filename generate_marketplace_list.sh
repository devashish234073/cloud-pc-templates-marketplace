#!/bin/bash

OUTPUT_FILE="marketplace_info_list.json"
echo "[" > "$OUTPUT_FILE"

FIRST=true

# Find all marketplace_info.json files (excluding the output file itself if it accidentally matches, though names differ)
find . -type f -name "marketplace_info.json" | sort | while read -r file; do
    if [ "$FIRST" = true ]; then
        FIRST=false
    else
        echo "," >> "$OUTPUT_FILE"
    fi
    cat "$file" >> "$OUTPUT_FILE"
done

echo "" >> "$OUTPUT_FILE"
echo "]" >> "$OUTPUT_FILE"

echo "Generated $OUTPUT_FILE"
